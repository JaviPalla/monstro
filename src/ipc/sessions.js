"use strict";

// Handlers IPC del panel Agents: las sesiones de Claude Code (src/sessions.js) y el lanzador del tablero
// (review de MR, pruebas, implementar tarea), que abre sesiones INTERACTIVAS en Ghostty. Se registran
// desde wireIpc().

const { ipcMain, dialog } = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const agents = require("../agents");
const config = require("../config");
const local = require("../local");
const provider = require("../provider");
const sessions = require("../sessions");

const pexec = promisify(execFile);
const MR_TTL_MS = 5 * 60 * 1000;
const TTY_RE = /^ttys\d{1,4}$/;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const QA_SKILL = "qa-checklist-gitlab"; // skill de usuario (~/.claude/skills), como mr-review-gitlab
const mrCache = new Map(); // "proyecto|rama" → { at, link }
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

// Pestaña nueva de Ghostty en `dir` que TECLEA `command` en tu shell (initial input, no `command`: así
// lleva tu PATH y tu glab, y la pestaña sigue viva al salir de claude). Los dos van por argv, nunca
// interpolados en el AppleScript; lo de dentro del comando lo entrecomilla sessions.claudeCommand.
const GHOSTTY_LAUNCH = [
  "on run argv",
  'tell application "Ghostty"',
  "activate",
  "set cfg to {initial working directory:(item 1 of argv), initial input:((item 2 of argv) & linefeed)}",
  "if (count of windows) is 0 then",
  "new window with configuration cfg",
  "else",
  "new tab in front window with configuration cfg",
  "end if",
  "end tell",
  "end run",
];

function openInGhostty(dir, command) {
  return pexec("osascript", [...appleScriptArgs(GHOSTTY_LAUNCH), dir, command], { timeout: 15000 });
}

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

// Link de MR / tarea / epic → sus MRs, cada una con el clon local de su repo (la skill hace ahí su worktree)
// y, si no se puede lanzar, por qué (`skip`). Review: solo sobre abiertas; pruebas: también sobre fusionadas
// (lo entregado se prueba). Las descartadas se devuelven igual: "no hay MRs" y "están todas fusionadas" no
// son lo mismo para quien pega el link.
async function launchTargets(url, action) {
  if (action !== "review" && action !== "tests") throw new Error("Acción desconocida.");
  const link = sessions.parseLink(url);
  if (!link || !["mr", "issue", "epic"].includes(link.kind)) throw new Error("Pega el link de una MR, una tarea o una epic de GitLab.");
  const found = link.kind === "mr"
    ? [{ mrUrl: link.url, title: null, state: "opened", taskUrl: null }]
    : await provider.current().taskMergeRequests(link.project, link.iid);
  const root = config.load().local.rootDir;
  const clones = root ? await local.scanRepos(root).catch(() => []) : [];
  return found.flatMap((m) => {
    const mr = sessions.parseLink(m.mrUrl);
    if (!mr) return [];
    const dir = clones.find((c) => c.gitlabPath === mr.project)?.dir || null;
    const launchable = m.state === "opened" || (action === "tests" && m.state === "merged");
    return [{ ...m, project: mr.project, iid: mr.iid, dir, skip: launchable ? (dir ? null : "no-clone") : m.state }];
  });
}

// Lo que teclea cada acción: la skill por slash command (el tablero la reconoce así como review).
function agentFor(action, target) {
  if (action === "review") return { name: `Review !${target.iid}`, prompt: `/mr-review-gitlab ${target.mrUrl}` };
  return { name: `Pruebas !${target.iid}`, prompt: `/${QA_SKILL} ${target.mrUrl}${target.taskUrl ? ` ${target.taskUrl}` : ""}` };
}

// Claude crea la tarea, pero solo tras tu OK: nada sale a GitLab sin que lo confirmes.
function implementPrompt(task, project, epicsProject) {
  return [
    task,
    "",
    "---",
    `Lanzado desde Monstro en un worktree de ${project}. Antes de tocar código:`,
    `1. Decide si esto es una epic (varios proyectos o varias entregas) o una tarea de ${project}.`,
    "2. Propón tipo, título y descripción, y ESPERA a que te diga que sí.",
    `3. Créala con glab (las epics van en ${epicsProject}; si es epic, crea dentro también la tarea de ${project}) y dame su URL.`,
    "Después implementa aquí, en este worktree: parte de la rama base actualizada (git fetch) y pon el número de la tarea en la rama y en los commits. Pregúntame antes de hacer push o abrir la MR.",
  ].join("\n");
}

function register(ctx) {
  // Última foto que vio el renderer: abrir editor, enfocar y reanudar solo actúan sobre sesiones y
  // carpetas de aquí, nunca sobre rutas que mande el renderer tal cual.
  let known = new Map();
  // Carpetas elegidas con el diálogo en esta sesión: "Implementar tarea" solo lanza en una de ellas.
  const pickedDirs = new Set();
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
  ipcMain.handle("sessions:resume", async (_event, { sessionId }) => {
    const s = known.get(sessionId);
    if (!s || s.live) throw new Error("Solo se pueden reanudar sesiones terminadas.");
    // En la carpeta donde ARRANCÓ: ahí busca `claude --resume` el transcript. El id es un UUID validado.
    await openInGhostty(startDirOf(s), `claude --resume ${s.sessionId}`);
    return { ok: true };
  });

  ipcMain.handle("sessions:launchTargets", (_event, { url, action }) => launchTargets(url, action));
  ipcMain.handle("sessions:launch", async (_event, { url, action }) => {
    // Se resuelve otra vez aquí: el renderer solo manda el link, nunca rutas.
    const targets = (await launchTargets(url, action)).filter((t) => !t.skip);
    if (!targets.length) throw new Error("Ninguna de esas MRs tiene un clon local donde lanzar el agente.");
    for (const t of targets) await openInGhostty(t.dir, sessions.claudeCommand(agentFor(action, t)));
    return { launched: targets.length };
  });
  ipcMain.handle("sessions:pickDir", async () => {
    const res = await dialog.showOpenDialog(ctx.win, { properties: ["openDirectory"], title: "¿Dónde lanzo el agente?", defaultPath: config.load().local.rootDir || undefined });
    const dir = !res.canceled && res.filePaths[0];
    if (!dir) return null;
    const repo = await sessions.repoOf(dir);
    if (!repo) throw new Error("Esa carpeta no es un repo git: el agente trabaja en un worktree suyo.");
    pickedDirs.add(dir);
    return { dir, project: repo.project, name: repo.name };
  });
  ipcMain.handle("sessions:implement", async (_event, { prompt, dir }) => {
    const task = String(prompt || "").trim();
    if (!task) throw new Error("Escribe qué hay que hacer.");
    if (!pickedDirs.has(dir)) throw new Error("Elige antes la carpeta donde lanzarlo.");
    const repo = await sessions.repoOf(dir);
    const group = config.load().milestones?.group || (repo?.project || "").split("/")[0];
    await openInGhostty(dir, sessions.claudeCommand({
      name: `Implementar: ${task.split(/\s+/).slice(0, 6).join(" ")}`,
      worktree: sessions.launchSlug(task),
      prompt: implementPrompt(task, repo?.project || repo?.name || dir, group ? `${group}/epics` : "el proyecto epics del grupo"),
    }));
    return { ok: true };
  });
}

module.exports = { register };
