"use strict";

// Handlers IPC del panel Agents: las sesiones de Claude Code (src/sessions.js) y el lanzador del tablero
// (review de MR, pruebas, implementar tarea), que abre sesiones INTERACTIVAS en Ghostty. Se registran
// desde wireIpc().

const { ipcMain, dialog, nativeImage } = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");
const path = require("path");
const agents = require("../agents");
const config = require("../config");
const local = require("../local");
const provider = require("../provider");
const sessions = require("../sessions");
const sessionDetail = require("../sessions-detail");

const pexec = promisify(execFile);
const MR_TTL_MS = 5 * 60 * 1000;
const TTY_RE = /^ttys\d{1,4}$/;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const QA_SKILL = "qa-checklist-gitlab"; // skill de usuario (~/.claude/skills), como mr-review-gitlab
const mrCache = new Map(); // "proyecto|rama" → { at, link }
const linkCache = new Map(); // key del link → { at, detail } (ficha de la sesión)
// statusCheckRollup (forma GitHub) → los tres estados del pipeline que pinta la ficha.
const PIPELINE_STATE = { SUCCESS: "SUCCESS", FAILURE: "FAILURE", ERROR: "FAILURE", PENDING: "PENDING", EXPECTED: "PENDING" };
const GL_STATE = { OPEN: "opened", MERGED: "merged", CLOSED: "closed" }; // enum GitHub → estado de withClones
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

// Iconos reales de las apps del botón "Abrir" (dataURL), solo de las que hay en este Mac. La app se busca
// por bundle id en Spotlight y, si no la indexa (a iTerm le pasa), en las rutas de siempre (Toolbox
// instala en ~/Applications). createThumbnailFromPath y no app.getFileIcon: en macOS este va por tipo de
// fichero y da el icono genérico de .app a todas (y con size "large" tumba el proceso).
const APP_BUNDLES = {
  ghostty: { id: "com.mitchellh.ghostty", file: "Ghostty.app" },
  rider: { id: "com.jetbrains.rider", file: "Rider.app" },
  vscode: { id: "com.microsoft.VSCode", file: "Visual Studio Code.app" },
  terminal: { id: "com.apple.Terminal", file: "Terminal.app" },
  iterm: { id: "com.googlecode.iterm2", file: "iTerm.app" },
};
const APP_DIRS = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications/Utilities"];
const APP_ICON_PX = 32; // se pinta a 16 px: nítido en retina
let appIconsPromise = null; // una vez por arranque: las apps no se mueven

async function bundlePath({ id, file }) {
  try {
    const { stdout } = await pexec("mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], { timeout: 5000 });
    const found = stdout.split("\n").find((p) => p.endsWith(".app") && fs.existsSync(p));
    if (found) return found;
  } catch { /* sin Spotlight: las rutas de siempre */ }
  return APP_DIRS.map((dir) => path.join(dir, file)).find((p) => fs.existsSync(p)) || null;
}

async function appIcon(bundle) {
  const where = await bundlePath(bundle);
  if (!where) return null;
  const image = await nativeImage.createThumbnailFromPath(where, { width: APP_ICON_PX, height: APP_ICON_PX });
  return image.isEmpty() ? null : image.toDataURL();
}

function appIcons() {
  appIconsPromise ??= Promise.all(Object.entries(APP_BUNDLES).map(async ([key, bundle]) => [key, await appIcon(bundle).catch(() => null)]))
    .then((pairs) => Object.fromEntries(pairs.filter(([, icon]) => icon)));
  return appIconsPromise;
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

// Datos en vivo de un link de la sesión, por el proveedor: MR/PR con prDetail, issue/epic con issueDetail.
async function fetchLinkDetail(link) {
  const p = provider.current();
  if (link.kind === "mr" || link.kind === "pr") {
    const pr = await p.prDetail(link.project, link.iid);
    return {
      title: pr.title,
      state: pr.state,
      author: pr.author?.login || null,
      draft: Boolean(pr.isDraft),
      sourceBranch: pr.headRefName || null,
      targetBranch: pr.baseRefName || null,
      pipeline: PIPELINE_STATE[pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] || null,
      updatedAt: pr.updatedAt || null,
    };
  }
  const issue = await p.issueDetail(link.project, link.iid);
  return { title: issue.title, state: issue.state, author: issue.author?.login || null, draft: false, sourceBranch: null, targetBranch: null, pipeline: null, updatedAt: issue.updatedAt || null };
}

// 5 min por link. Uno que falle (sin permisos, borrado, otro host) sale con title null y no tumba a los demás;
// no se cachea, así un fallo de red se arregla al volver a abrir la ficha.
async function linkDetail(link) {
  const hit = linkCache.get(link.key);
  if (hit && Date.now() - hit.at < MR_TTL_MS) return hit.detail;
  const base = { key: link.key, kind: link.kind, iid: link.iid, project: link.project, url: link.url };
  try {
    const detail = { ...base, ...(await fetchLinkDetail(link)) };
    linkCache.set(link.key, { at: Date.now(), detail });
    return detail;
  } catch {
    return { ...base, title: null, state: link.state || null, author: null, draft: false, sourceBranch: null, targetBranch: null, pipeline: null, updatedAt: null };
  }
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
  return withClones(found, action);
}

// MRs ({mrUrl, state: opened|merged|closed…}) → con el clon local de su repo (`dir`) y, si no se puede lanzar,
// por qué (`skip`). Lo comparten el lanzador del tablero y "lanzar sobre sus MRs" de la ficha.
async function withClones(found, action) {
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
  // Comando integrado de Claude Code: revisa los cambios de la rama ACTUAL (se lanza en un worktree de la MR).
  if (action === "security") return { name: `Seguridad !${target.iid}`, prompt: "/security-review" };
  return { name: `Pruebas !${target.iid}`, prompt: `/${QA_SKILL} ${target.mrUrl}${target.taskUrl ? ` ${target.taskUrl}` : ""}` };
}

// Review / seguridad sobre las MRs de una sesión (keys null = todas). Solo abiertas y con clon local, como el
// lanzador; lo que no se lanza vuelve en `skipped` con su motivo, y un fallo en una MR no para las demás.
async function launchOnLinks(s, action, keys) {
  if (action !== "review" && action !== "security") throw new Error("Acción desconocida.");
  if (keys !== null && (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))) throw new Error("Selección de MRs no válida.");
  const mrs = s.links.filter((l) => (l.kind === "mr" || l.kind === "pr") && (!keys || keys.includes(l.key)));
  if (!mrs.length) throw new Error("Esta sesión no tiene MRs sobre las que lanzar.");
  const details = await Promise.all(mrs.map(linkDetail));
  const found = details.map((d) => ({ key: d.key, mrUrl: d.url, title: d.title, state: GL_STATE[d.state] || "unknown", taskUrl: null, sourceBranch: d.sourceBranch }));
  const skipped = [];
  let launched = 0;
  for (const t of await withClones(found, action)) {
    if (t.skip) {
      skipped.push({ key: t.key, reason: t.skip });
      continue;
    }
    if (action === "security" && !t.sourceBranch) {
      skipped.push({ key: t.key, reason: "no-branch" });
      continue;
    }
    try {
      // /security-review mira la rama en la que está: worktree de la rama de la MR (reutiliza el que ya haya).
      const dir = action === "security" ? await local.branchWorktree(t.dir, t.sourceBranch) : t.dir;
      await openInGhostty(dir, sessions.claudeCommand(agentFor(action, t)));
      launched++;
    } catch (err) {
      skipped.push({ key: t.key, reason: err.message });
    }
  }
  return { launched, skipped };
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

// Carpeta raíz ("todos los repos"): el agente decide qué proyectos tocar y abre un worktree en cada uno
// (nunca toca los clones). Todos en `.worktrees/<slug>`: así Agents los reconoce y los limpia después.
function implementMultiPrompt(task, clones, epicsProject, slug) {
  return [
    task,
    "",
    "---",
    "Lanzado desde Monstro en tu carpeta de repos: aquí no hay repo git, cada subcarpeta es un clon (carpeta → proyecto de GitLab):",
    ...clones.map((c) => `- ${c.name} → ${c.gitlabPath || "sin origin"}`),
    "Antes de tocar código:",
    "1. Explora (solo lectura) y decide qué proyectos hay que cambiar. Los clones son del usuario: no los modifiques nunca.",
    `2. Propón el trabajo y ESPERA a que te diga que sí: una tarea si es un solo proyecto; si son varios, una epic en ${epicsProject} con una tarea en cada proyecto.`,
    "3. Créalas con glab y dame sus URLs.",
    `4. En cada proyecto que toques, un worktree nuevo desde su rama base actualizada: git -C <clon> fetch origin y git -C <clon> worktree add .worktrees/${slug} -b <rama con el número de su tarea> origin/<rama base>. Si .worktrees/ no está en su .gitignore, añádelo a .git/info/exclude. Trabaja solo ahí.`,
    "Después implementa: una MR por proyecto, cada una enlazada a su tarea. Pregúntame antes de cada push y de abrir cada MR. No borres los worktrees al acabar: se limpian desde Monstro (Agents) cuando cierres esta sesión.",
  ].join("\n");
}

// ¿Es uno de tus clones (repos git justo bajo la carpeta raíz de Trabajo local)? Se re-escanea aquí: del
// renderer solo llega la ruta, igual que el link en sessions:launch.
async function isClone(dir) {
  const clones = await local.scanRepos(config.load().local.rootDir).catch(() => []);
  return clones.some((c) => c.dir === dir);
}

// Última foto que vio el renderer: abrir editor, enfocar y reanudar solo actúan sobre sesiones y
// carpetas de aquí, nunca sobre rutas que mande el renderer tal cual. A nivel de módulo porque
// "Probar en local" (src/ipc/local-run.js) resuelve la sesión con el mismo `sessionOf`.
let known = new Map();

function sessionOf(sessionId) {
  const s = known.get(sessionId);
  if (!s) throw new Error("Esa sesión ya no está en el panel.");
  return s;
}

function register(ctx) {
  // Carpetas elegidas con el diálogo en esta sesión: "Implementar tarea" solo lanza en una de ellas o en un clon.
  const pickedDirs = new Set();
  const startDirOf = (s) => {
    if (!s.startDir || !fs.existsSync(s.startDir)) throw new Error("La carpeta de la sesión ya no existe.");
    return s.startDir;
  };
  // El transcript lo resuelve main (de la última lista); el renderer solo manda el id.
  const transcriptOf = (sessionId) => {
    sessionOf(sessionId);
    const file = sessions.transcriptFor(sessionId);
    if (!file) throw new Error("No encuentro el transcript de esa sesión.");
    return file;
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
  ipcMain.handle("sessions:appIcons", () => appIcons());
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
    // Un repo, o una carpeta sin .git con clones dentro (el agente abrirá un worktree en cada uno que toque).
    const repo = await sessions.repoOf(dir);
    const clones = repo ? [] : await local.scanRepos(dir);
    if (!repo && !clones.length) throw new Error("Esa carpeta no es un repo git ni tiene repos dentro: el agente trabaja en worktrees.");
    pickedDirs.add(dir);
    return repo ? { dir, project: repo.project, name: repo.name } : { dir, project: null, name: path.basename(dir), multi: true };
  });
  ipcMain.handle("sessions:implement", async (_event, { prompt, dir }) => {
    const task = String(prompt || "").trim();
    if (!task) throw new Error("Escribe qué hay que hacer.");
    const root = config.load().local.rootDir;
    if (!pickedDirs.has(dir) && !(root && dir === root) && !(await isClone(dir))) throw new Error("Elige antes el repo o la carpeta donde lanzarlo.");
    const repo = await sessions.repoOf(dir);
    const clones = repo ? [] : await local.scanRepos(dir);
    if (!repo && !clones.length) throw new Error("En esa carpeta no hay ningún repo git.");
    const group = config.load().milestones?.group || (repo?.project || clones.find((c) => c.gitlabPath)?.gitlabPath || "").split("/")[0];
    const epics = group ? `${group}/epics` : "el proyecto epics del grupo";
    const name = `Implementar: ${task.split(/\s+/).slice(0, 6).join(" ")}`;
    const slug = sessions.launchSlug(task);
    // Un repo: `claude -w` le hace el worktree. La carpeta raíz no es un repo: sin -w, y el agente abre un
    // worktree en cada proyecto que toque.
    await openInGhostty(dir, repo
      ? sessions.claudeCommand({ name, worktree: slug, prompt: implementPrompt(task, repo.project || repo.name, epics) })
      : sessions.claudeCommand({ name, prompt: implementMultiPrompt(task, clones, epics, slug) }));
    return { ok: true };
  });

  // Solo sesiones terminadas (nadie trabaja ya ahí) y nunca un worktree que use otra sesión viva.
  ipcMain.handle("sessions:cleanWorktrees", async (_event, { sessionId }) => {
    const s = known.get(sessionId);
    if (!s || s.live) throw new Error("Solo se limpian los worktrees de sesiones terminadas.");
    const busy = new Set([...known.values()].filter((x) => x.live).flatMap((x) => x.worktrees));
    const results = [];
    // Uno a uno: si uno no se puede quitar, los demás siguen (y se informa de cada uno).
    for (const dir of s.worktrees.filter((d) => sessions.agentWorktree(d))) {
      if (busy.has(dir)) results.push({ dir, ok: false, reason: "busy" });
      else if (await local.isDirty(dir)) results.push({ dir, ok: false, reason: "dirty" });
      else results.push(await local.removeCleanWorktree(dir).then(() => ({ dir, ok: true }), (err) => ({ dir, ok: false, reason: err.message })));
    }
    return results;
  });

  /* ---------- ficha: detalle bajo demanda, links en vivo y lanzar sobre sus MRs ---------- */
  ipcMain.handle("sessions:detail", async (_event, { sessionId }) => sessionDetail.read(transcriptOf(sessionId)));
  ipcMain.handle("sessions:linkDetails", async (_event, { sessionId }) => Promise.all(sessionOf(sessionId).links.map(linkDetail)));
  ipcMain.handle("sessions:launchOnLinks", async (_event, { sessionId, action, keys }) => launchOnLinks(sessionOf(sessionId), action, keys ?? null));
}

// openInGhostty / linkDetail / sessionOf los reusa "Probar en local" (src/ipc/local-run.js): misma
// pestaña de Ghostty, la misma caché de 5 min de los links y la misma foto de sesiones.
module.exports = { register, openInGhostty, linkDetail, sessionOf };
