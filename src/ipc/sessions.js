"use strict";

// Handlers IPC del panel de sesiones de Claude Code (src/sessions.js). Se registran desde wireIpc().

const { ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const agents = require("../agents");
const config = require("../config");
const provider = require("../provider");
const sessions = require("../sessions");

const pexec = promisify(execFile);
const MR_TTL_MS = 5 * 60 * 1000;
const TTY_RE = /^ttys\d{1,4}$/;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const mrCache = new Map(); // "proyecto|rama" → { at, link }
const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const appleScriptArgs = (lines) => lines.flatMap((l) => ["-e", l]);

// Ghostty (1.3+) no expone el TTY por AppleScript y el título de una sesión parada no cambia, así que
// Monstro titula él mismo la pestaña: escribe un OSC 2 con un marcador único en el TTY de la sesión
// (lo consume el terminal, la TUI no lo ve), la busca por nombre exacto y la enfoca. Requiere que la
// config de Ghostty no fuerce `title=`, que ignora los títulos que mandan los programas.
const GHOSTTY_FOCUS = [
  "on run argv",
  "set marker to item 1 of argv",
  'tell application "Ghostty"',
  "repeat 20 times",
  "repeat with w in windows",
  "repeat with t in tabs of w",
  "repeat with s in terminals of t",
  "if (name of s) is marker then",
  "focus s",
  'return "exact"',
  "end if",
  "end repeat",
  "end repeat",
  "end repeat",
  "delay 0.1",
  "end repeat",
  "end tell",
  'return "none"',
  "end run",
];

// Título de pestaña vía OSC 2. Fuera caracteres de control: un ESC o BEL dentro cortaría la secuencia.
function setTerminalTitle(tty, title) {
  if (!TTY_RE.test(tty || "")) throw new Error("No encuentro el terminal de esta sesión.");
  const clean = [...String(title)].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
  return fs.promises.writeFile(`/dev/${tty}`, `${ESC}]2;${clean}${BEL}`);
}

// Apps que traen al frente la ventana del proyecto al abrirles su carpeta. Terminal/iTerm abrirían
// una ventana NUEVA con la carpeta, así que a esos solo se les activa.
// ponytail: Terminal/iTerm sin elegir pestaña; casar por `tty` si alguien los usa.
const HOST_APP = { vscode: "Visual Studio Code", "vscode-ext": "Visual Studio Code", rider: "Rider", terminal: "Terminal", iterm: "iTerm" };

async function focusGhostty(s) {
  const marker = `monstro-${s.sessionId.slice(0, 8)}-${Date.now()}`;
  await setTerminalTitle(s.tty, marker);
  try {
    const { stdout } = await pexec("osascript", [...appleScriptArgs(GHOSTTY_FOCUS), marker], { timeout: 8000 });
    return { ok: true, match: stdout.trim() };
  } finally {
    // La pestaña se queda con el título de la sesión, no con el marcador.
    await setTerminalTitle(s.tty, s.title).catch(() => {});
  }
}

async function focusSession(s) {
  if (s.host === "ghostty") return focusGhostty(s);
  const app = HOST_APP[s.host];
  if (!app) throw new Error("No sé en qué app corre esta sesión.");
  const withDir = s.host !== "terminal" && s.host !== "iterm";
  await pexec("open", withDir ? ["-a", app, s.startDir] : ["-a", app]);
  // La extensión de VS Code abre además la pestaña exacta de esa sesión (su handleUri /open?session=).
  if (s.host === "vscode-ext") await pexec("open", [`vscode://Anthropic.claude-code/open?session=${s.sessionId}`]);
  return { ok: true, match: s.host === "vscode-ext" ? "exact" : "window" };
}

async function branchMr(project, branch) {
  const cacheKey = `${project}|${branch}`;
  const hit = mrCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MR_TTL_MS) return hit.link;
  let link = null;
  try {
    const mr = await provider.current().mrForBranch(project, branch);
    const parsed = mr && sessions.parseLink(mr.url);
    if (parsed) link = { ...parsed, state: mr.state };
  } catch { /* sin permisos o proyecto de otro host: sin badge */ }
  mrCache.set(cacheKey, { at: Date.now(), link });
  return link;
}

function linkScope(cfg) {
  let host = "github.com";
  if (cfg.provider === "gitlab") {
    try { host = new URL(cfg.gitlabBaseUrl).host; } catch { host = "gitlab.com"; }
  }
  return { host, groups: new Set((cfg.repos || []).map((r) => r.split("/")[0])) };
}

function register() {
  // Última foto que vio el renderer: abrir editor, enfocar y reanudar solo actúan sobre sesiones y
  // carpetas de aquí, nunca sobre rutas que mande el renderer tal cual.
  let known = new Map();
  const startDirOf = (s) => {
    if (!s.startDir || !fs.existsSync(s.startDir)) throw new Error("La carpeta de la sesión ya no existe.");
    return s.startDir;
  };

  ipcMain.handle("sessions:list", async () => {
    const list = await sessions.list({ ...linkScope(config.load()), branchMr });
    known = new Map(list.map((s) => [s.sessionId, s]));
    return list;
  });
  ipcMain.handle("sessions:tag", (_event, { sessionId, url }) => sessions.tag(sessionId, url));
  ipcMain.handle("sessions:untag", (_event, { sessionId, key }) => sessions.untag(sessionId, key));
  ipcMain.handle("sessions:openEditor", (_event, { sessionId, dir }) => {
    const s = known.get(sessionId);
    const dirs = s ? [s.dir, ...s.repos.map((r) => r.dir)] : [];
    if (!dir || !dirs.includes(dir)) throw new Error("Carpeta desconocida para esa sesión.");
    if (!fs.existsSync(dir)) throw new Error("La carpeta ya no existe (¿worktree borrado?).");
    return agents.openEditor(dir);
  });
  ipcMain.handle("sessions:focus", (_event, { sessionId }) => {
    const s = known.get(sessionId);
    if (!s || !s.live) throw new Error("Esa sesión ya no está viva.");
    startDirOf(s);
    return focusSession(s);
  });
  ipcMain.handle("sessions:resume", (_event, { sessionId }) => {
    const s = known.get(sessionId);
    if (!s || s.live) throw new Error("Solo se pueden reanudar sesiones terminadas.");
    // El comando va por argv, no interpolado en el AppleScript: no puede romper el script.
    // ponytail: Terminal.app fijo; si se usa iTerm/Ghostty, hacerlo configurable.
    const command = `cd ${shellQuote(startDirOf(s))} && claude --resume ${s.sessionId}`;
    const script = ["on run argv", 'tell application "Terminal"', "activate", "do script (item 1 of argv)", "end tell", "end run"];
    spawn("osascript", [...appleScriptArgs(script), command], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  });
}

module.exports = { register };
