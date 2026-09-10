"use strict";

/**
 * Sesiones de Claude Code de esta máquina (vivas + terminadas en las últimas 24h) para el panel
 * derecho. No hay API: se lee lo que el CLI deja en disco.
 *  - Vivas: ~/.claude/sessions/<pid>.json ({pid, sessionId, cwd, name, status, entrypoint…}).
 *  - Transcripts: ~/.claude/projects/<dir>/<sessionId>.jsonl → título, cwds/ramas, ficheros tocados
 *    y URLs de MR/issue/epic/PR. Se leen INCREMENTALMENTE (son append-only y los hay de 10 MB).
 * Sin electron salvo el store de tags (require perezoso) → scripts/test-sessions.js lo prueba con node.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { remotePath } = require("./local");
const { editorStack } = require("./agents");

const pexec = promisify(execFile);
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTY_RE = /^ttys\d{1,4}$/;
// Sin `status` (extensión de VS Code) un turno a medias sin actividad en este tiempo casi siempre es un
// permiso o pregunta pendiente, no trabajo. ponytail: heurística; un build muy largo saldría "esperándote".
const WORKING_STALE_MS = 2 * 60 * 1000;
// Ramas que no identifican trabajo concreto: buscarles MR solo daría ruido.
const TRUNK_RE = /^(development|develop|main|master|HEAD)$|^rb\//;

// GitLab: https://host/grupo/…/proyecto/-/merge_requests|issues|work_items/N
const GL_URL_RE = /https:\/\/([\w.-]+)\/([\w.-]+(?:\/[\w.-]+)+)\/-\/(merge_requests|issues|work_items)\/(\d+)/g;
// GitHub: https://github.com/owner/repo/pull|issues/N
const GH_URL_RE = /https:\/\/(github\.com)\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g;
// Regex sobre la línea cruda: un JSON incrustado en un tool_result va escapado (\"cwd\":\"…\") y no
// casa, así que solo cuentan los campos de primer nivel (y los input de las tool calls).
const CWD_RE = /"cwd":"([^"]+)"/;
const BRANCH_RE = /"gitBranch":"([^"]+)"/;
const ENTRYPOINT_RE = /"entrypoint":"([\w-]+)"/;
// Actividad = último timestamp de mensaje. El mtime NO sirve: el CLI sigue escribiendo líneas de
// sistema (away_summary…) en sesiones paradas y todas parecerían de "ahora".
const TS_RE = /"timestamp":"([^"]+)"/;
const FILE_RE = /"file_path":"(\/[^"]+)"/g;
const META_RE = /^\{"type":"(ai-title|custom-title|agent-name|last-prompt|pr-link)"/;

function linkFrom(host, project, type, iid) {
  let kind = "issue";
  if (type === "merge_requests") kind = "mr";
  else if (type === "pull") kind = "pr";
  else if (/\/epics$/i.test(project)) kind = "epic"; // misma regla que isEpicUrl (src/gitlab/issues.js)
  const github = host === "github.com";
  const segment = { mr: "-/merge_requests", pr: "pull" }[kind] || (github ? "issues" : "-/issues");
  return { key: `${kind}:${host}/${project}#${iid}`, kind, host, project, iid: Number(iid), url: `https://${host}/${project}/${segment}/${iid}` };
}

// URL de MR/issue/epic (GitLab) o PR/issue (GitHub) → link canónico, o null.
function parseLink(url) {
  const text = String(url || "").trim();
  for (const re of [GL_URL_RE, GH_URL_RE]) {
    const m = new RegExp(re.source).exec(text);
    if (m) return linkFrom(m[1], m[2], m[3], m[4]);
  }
  return null;
}

const freshAcc = () => ({
  offset: 0, seq: 0, lastAt: 0, entrypoint: null, aiTitle: null, customTitle: null, agentName: null, lastPrompt: null,
  firstCwd: null, lastCwd: null, dirs: new Map(), branches: new Map(), links: new Map(),
  lastAssistant: null, lastAssistantSeq: 0, lastUserSeq: 0, turn: null, turnSeq: -1, review: false,
});

function addLink(acc, link, fromPrLink) {
  if (!link) return;
  const prev = acc.links.get(link.key);
  acc.links.set(link.key, { ...link, count: (prev?.count || 0) + 1, fromPrLink: fromPrLink || !!prev?.fromPrLink });
}

function scanLine(acc, line) {
  if (!line) return;
  acc.seq++;
  if (META_RE.test(line)) {
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    if (entry.aiTitle) acc.aiTitle = entry.aiTitle;
    if (entry.customTitle) acc.customTitle = entry.customTitle;
    if (entry.agentName) acc.agentName = entry.agentName;
    if (entry.lastPrompt) acc.lastPrompt = entry.lastPrompt;
    if (entry.prUrl) addLink(acc, parseLink(entry.prUrl), true);
    return;
  }
  acc.entrypoint ??= ENTRYPOINT_RE.exec(line)?.[1] || null;
  const ts = Date.parse(TS_RE.exec(line)?.[1]);
  if (ts > acc.lastAt) acc.lastAt = ts;
  // Solo se guarda la última línea de Claude (se parsea al construir la sesión, en lastTurn) y la
  // posición del último mensaje tuyo o resultado de herramienta: basta para saber de quién es el turno.
  if (line.includes('"type":"assistant"')) {
    acc.lastAssistant = line;
    acc.lastAssistantSeq = acc.seq;
  } else if (line.includes('"type":"user"')) {
    acc.lastUserSeq = acc.seq;
  }
  // Sesión de la skill de review de MRs (su llamada a la tool Skill; mencionarla en un texto va escapado).
  if (!acc.review && line.includes('"skill":"mr-review-gitlab"')) acc.review = true;
  const cwd = CWD_RE.exec(line)?.[1];
  if (cwd) {
    acc.firstCwd ??= cwd;
    acc.lastCwd = cwd;
    acc.dirs.set(cwd, acc.seq);
    const branch = BRANCH_RE.exec(line)?.[1];
    // "HEAD" = detached; ".invalid" = lo que escribe el CLI fuera de una rama (git no admite nombres con "." inicial).
    if (branch) acc.branches.set(cwd, branch === "HEAD" || branch.startsWith(".") ? null : branch);
  }
  for (const m of line.matchAll(FILE_RE)) acc.dirs.set(path.dirname(m[1]), acc.seq);
  for (const re of [GL_URL_RE, GH_URL_RE]) {
    for (const m of line.matchAll(re)) addLink(acc, linkFrom(m[1], m[2], m[3], m[4]), false);
  }
}

const transcriptCache = new Map();
const inflightScans = new Map();

async function readNewLines(file) {
  const { size } = await fs.promises.stat(file);
  let acc = transcriptCache.get(file);
  if (!acc || size < acc.offset) acc = freshAcc(); // truncado o reescrito → de cero
  transcriptCache.set(file, acc);
  if (size <= acc.offset) return acc;
  // ponytail: el trozo nuevo entero en memoria; el primer escaneo es el fichero completo (~10 MB el mayor visto).
  const buf = Buffer.alloc(size - acc.offset);
  const fh = await fs.promises.open(file, "r");
  try { await fh.read(buf, 0, buf.length, acc.offset); } finally { await fh.close(); }
  const end = buf.lastIndexOf(10); // solo líneas completas: la última puede estar a medio escribir
  if (end < 0) return acc;
  for (const line of buf.toString("utf8", 0, end).split("\n")) scanLine(acc, line);
  acc.offset += end + 1;
  return acc;
}

// Un escaneo por fichero a la vez: dos polls solapados leerían el mismo trozo y duplicarían contadores.
function scanTranscript(file) {
  if (!inflightScans.has(file)) inflightScans.set(file, readNewLines(file).finally(() => inflightScans.delete(file)));
  return inflightScans.get(file);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Dónde corre un proceso: el primer ancestro que sea una app conocida. El orden importa: la extensión
// de VS Code cuelga de "Code Helper (Plugin)" y su terminal integrado de "Code Helper".
const HOST_BY_COMM = [
  [/^ghostty$/i, "ghostty"],
  [/^rider$/i, "rider"],
  [/^Code Helper \(Plugin\)$/, "vscode-ext"],
  [/^Code( Helper)?$/, "vscode"],
  [/^Terminal$/, "terminal"],
  [/^iTerm2$/, "iterm"],
];

// Nombres de los ancestros (del padre hacia arriba) → host, o null.
function hostFromChain(comms) {
  for (const comm of comms) {
    const hit = HOST_BY_COMM.find(([re]) => re.test(comm));
    if (hit) return hit[1];
  }
  return null;
}

// Un solo `ps` para todas las sesiones vivas → Map<pid, {host, tty}>. El TTY es lo que permite a
// Ghostty encontrar la pestaña exacta (src/ipc/sessions.js).
async function processInfo(pids) {
  const info = new Map();
  let stdout;
  try { ({ stdout } = await pexec("ps", ["-A", "-o", "pid=,ppid=,tty=,comm="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })); } catch { return info; }
  const parent = new Map();
  const comm = new Map();
  const tty = new Map();
  for (const row of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(row);
    if (!m) continue;
    parent.set(Number(m[1]), Number(m[2]));
    tty.set(Number(m[1]), m[3]);
    comm.set(Number(m[1]), path.basename(m[4].trim()));
  }
  for (const pid of pids) {
    const chain = [];
    for (let p = parent.get(pid); p > 1 && chain.length < 15; p = parent.get(p)) chain.push(comm.get(p) || "");
    info.set(pid, { host: hostFromChain(chain), tty: TTY_RE.test(tty.get(pid) || "") ? tty.get(pid) : null });
  }
  return info;
}

function liveSessions() {
  const dir = path.join(CLAUDE_DIR, "sessions");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  // La extensión de VS Code relanza el proceso al reanudar y el viejo puede seguir vivo con el mismo
  // sessionId: una fila por sesión, la del proceso más reciente.
  const bySession = new Map();
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      // ponytail: un PID reciclado por otro proceso daría la sesión por viva; comparar procStart si pasa.
      if (!UUID_RE.test(s.sessionId || "") || !Number.isInteger(s.pid) || (s.kind && s.kind !== "interactive") || !isAlive(s.pid)) continue;
      const prev = bySession.get(s.sessionId);
      if (!prev || (s.startedAt || 0) > (prev.startedAt || 0)) bySession.set(s.sessionId, s);
    } catch { /* fichero a medio escribir: saldrá en el siguiente poll */ }
  }
  return [...bySession.values()];
}

// sessionId → transcript más reciente (se indexa por nombre de fichero, sin adivinar cómo codifica el cwd).
function transcriptIndex() {
  const root = path.join(CLAUDE_DIR, "projects");
  const index = new Map();
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return index; }
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) {
      const id = f.slice(0, -".jsonl".length);
      if (!f.endsWith(".jsonl") || !UUID_RE.test(id)) continue;
      const file = path.join(root, d.name, f);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!index.has(id) || index.get(id).mtimeMs < mtimeMs) index.set(id, { path: file, mtimeMs });
      } catch { /* borrado entre readdir y stat */ }
    }
  }
  return index;
}

// ponytail: cachés para siempre (el remote de un repo no cambia); reiniciar la app si alguien lo mueve.
const originCache = new Map();
const repoCache = new Map();

function originOf(root) {
  if (!originCache.has(root)) {
    originCache.set(root, pexec("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 5000 })
      .then(({ stdout }) => remotePath(stdout.trim()))
      .catch(() => null));
  }
  return originCache.get(root);
}

// Carpeta → repo que la contiene ({root, project, name}) subiendo hasta el .git (vale para worktrees,
// donde .git es un fichero). Nada dentro de ~/.claude ni el propio $HOME cuentan como repo.
async function findRepo(dir) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (d === HOME || d === CLAUDE_DIR || d.startsWith(CLAUDE_DIR + path.sep)) return null;
    if (!fs.existsSync(path.join(d, ".git"))) continue;
    const project = await originOf(d);
    return { root: d, project, name: project ? project.split("/").pop() : path.basename(d) };
  }
  return null;
}

function repoOf(dir) {
  if (!repoCache.has(dir)) repoCache.set(dir, findRepo(dir));
  return repoCache.get(dir);
}

const clip = (text, max = 90) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || null;
};

// Repos de la sesión, el más reciente primero. `dir` es el que se abre en el editor: el último cwd
// dentro de ese repo (p.ej. su worktree), con la rama que tenía ahí.
async function sessionRepos(acc, dirs) {
  const byRepo = new Map();
  for (const [dir, seq] of [...dirs].sort((a, b) => a[1] - b[1])) {
    const repo = await repoOf(dir);
    if (!repo) continue;
    const key = repo.project || repo.root;
    const cur = byRepo.get(key) || { project: repo.project, name: repo.name, dir: null, branch: null };
    if (acc.branches.has(dir) || !cur.dir) {
      cur.dir = repo.root;
      cur.branch = acc.branches.get(dir) || null;
    }
    byRepo.delete(key); // reinsertar = el Map queda ordenado por recencia
    byRepo.set(key, cur);
  }
  return [...byRepo.values()].reverse().map((r) => ({ ...r, stack: editorStack(r.dir) }));
}

async function sessionLinks(id, acc, repos, { host, groups, branchMr, tags }) {
  const inScope = (project) => groups.has(project.split("/")[0]);
  // Solo links del proveedor configurado y de sus grupos: fuera quedan URLs de docs o de otros hosts.
  const auto = [...acc.links.values()]
    .filter((l) => l.fromPrLink || (l.host === host && inScope(l.project)))
    .sort((a, b) => b.count - a.count);
  const fromBranches = [];
  if (branchMr) {
    for (const r of repos) {
      if (!r.project || !r.branch || TRUNK_RE.test(r.branch) || !inScope(r.project)) continue;
      const link = await branchMr(r.project, r.branch);
      if (link) fromBranches.push(link);
    }
  }
  const tag = tags[id] || { add: [], hide: [] };
  const manual = tag.add.map(parseLink).filter(Boolean).map((l) => ({ ...l, manual: true }));
  const hidden = new Set(tag.hide);
  const seen = new Set();
  const out = [];
  for (const l of [...manual, ...fromBranches, ...auto]) {
    if (hidden.has(l.key) || seen.has(l.key)) continue;
    seen.add(l.key);
    out.push({ key: l.key, kind: l.kind, project: l.project, iid: l.iid, url: l.url, manual: !!l.manual, state: l.state || null });
  }
  return out;
}

// Herramienta → "Edit · app/sessions.js", "Bash · npm run build"…
function toolSummary({ name, input = {} }) {
  const target = input.file_path?.split("/").slice(-2).join("/") || input.command || input.pattern || input.url || input.description || "";
  return clip(target ? `${name} · ${target}` : name, 80);
}

// Pregunta de verdad = párrafo que TERMINA en "?". Las retóricas ("¿Y sabes por qué? Porque…") van
// seguidas de su respuesta, y la `?.` de código nunca cierra párrafo.
const ENDS_WITH_QUESTION_RE = /\?[)"'»\s]*$/;

// Cómo cierra Claude el turno, en plano. Si uno de los dos últimos párrafos acaba preguntando, te está
// esperando y el extracto es esa pregunta; si no, es un informe de trabajo hecho y el extracto su último párrafo.
function closing(text) {
  if (!text) return { asks: false, excerpt: null };
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/\*\*|__|`/g, "").replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const tail = plain.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(-2);
  const question = tail.findLast((p) => ENDS_WITH_QUESTION_RE.test(p));
  return { asks: !!question, excerpt: clip(question || tail.at(-1), 240) };
}

// Cómo acabó lo último que hizo Claude: si cerró el turno, su último texto y su última herramienta.
function lastTurn(acc) {
  if (acc.turnSeq === acc.seq) return acc.turn;
  let entry = null;
  try { entry = acc.lastAssistant && JSON.parse(acc.lastAssistant); } catch { /* línea corrupta: sin turno */ }
  const blocks = entry?.type === "assistant" && Array.isArray(entry.message?.content) ? entry.message.content : [];
  const text = blocks.findLast((b) => b.type === "text" && b.text?.trim())?.text;
  const tool = blocks.findLast((b) => b.type === "tool_use");
  acc.turn = {
    ended: acc.lastAssistantSeq > acc.lastUserSeq && entry?.message?.stop_reason === "end_turn",
    ...closing(text),
    activity: tool ? toolSummary(tool) : null,
  };
  acc.turnSeq = acc.seq;
  return acc.turn;
}

// Estado para el panel:
//  - waiting: te necesita (pide permiso/respuesta, o cerró el turno con una pregunta),
//  - working: Claude está a lo suyo,
//  - done: proceso abierto pero con el trabajo entregado (turno cerrado sin preguntar nada),
//  - finished: el proceso ya no existe.
function sessionActivity(live, acc) {
  const turn = lastTurn(acc);
  const settled = turn.asks ? "waiting" : "done";
  let state = "finished";
  if (live?.status === "waiting") state = "waiting";
  else if (live?.status === "busy") state = "working";
  else if (live?.status === "idle") state = settled;
  else if (live && turn.ended) state = settled;
  // Sin status y con el turno a medias: trabajando, salvo que lleve un rato quieto (permiso pendiente).
  else if (live) state = Date.now() - acc.lastAt > WORKING_STALE_MS ? "waiting" : "working";
  return { state, waitingFor: live?.waitingFor || null, excerpt: turn.excerpt, activity: turn.activity };
}

async function buildSession({ id, live, transcript }, opts) {
  // Sin transcript no hay conversación: sesión recién abierta o proceso de reserva de la extensión.
  if (!transcript) return null;
  const acc = await scanTranscript(transcript.path);
  if (!live && acc.entrypoint === "sdk-cli") return null; // `claude -p` de Monstro (review IA / agentes)
  const title = acc.customTitle || acc.aiTitle || acc.agentName || clip(acc.lastPrompt);
  if (!live && !title) return null; // abierta y cerrada sin llegar a escribir nada
  const updatedAt = acc.lastAt || live?.updatedAt || live?.startedAt || transcript?.mtimeMs || 0;
  if (!live && updatedAt < opts.cutoff) return null; // mtime reciente pero sin actividad en 24h
  const dirs = new Map(acc.dirs);
  if (live && !dirs.has(live.cwd)) dirs.set(live.cwd, 0);
  const repos = await sessionRepos(acc, dirs);
  const dir = acc.lastCwd || live?.cwd;
  return {
    sessionId: id,
    live: !!live,
    ...sessionActivity(live, acc),
    entrypoint: live?.entrypoint || acc.entrypoint,
    title: title || live?.name || id.slice(0, 8),
    updatedAt,
    dir,
    stack: editorStack(dir),
    // Carpeta donde ARRANCÓ (primer cwd del transcript): ahí busca `claude --resume` el transcript y es la del
    // shell / workspace que se enfoca. El cwd del session file NO sirve: sigue a Claude cuando entra en un worktree.
    startDir: acc.firstCwd || live?.cwd,
    host: live?.host || null,
    tty: live?.tty || null,
    review: acc.review,
    repos,
    links: await sessionLinks(id, acc, repos, opts),
  };
}

/**
 * Sesiones para el panel: vivas primero, luego por actividad. `host`/`groups` acotan los links
 * inferidos al proveedor configurado; `branchMr(project, branch)` resuelve la MR de una rama (o null).
 */
async function list({ host, groups, branchMr }) {
  const live = liveSessions();
  const procs = await processInfo(live.map((s) => s.pid));
  for (const s of live) Object.assign(s, procs.get(s.pid) || { host: null, tty: null });
  const index = transcriptIndex();
  const rows = live.map((s) => ({ id: s.sessionId, live: s, transcript: index.get(s.sessionId) }));
  const liveIds = new Set(rows.map((r) => r.id));
  const cutoff = Date.now() - FINISHED_WINDOW_MS;
  for (const [id, transcript] of index) {
    if (!liveIds.has(id) && transcript.mtimeMs >= cutoff) rows.push({ id, live: null, transcript });
  }
  const tags = loadTags();
  const out = await Promise.all(rows.map((r) => buildSession(r, { host, groups, branchMr, tags, cutoff })));
  return out.filter(Boolean).sort((a, b) => (b.live - a.live) || (b.updatedAt - a.updatedAt));
}

/* ---------- badges a mano: userData/session-tags.json {[sessionId]: {add:[url], hide:[key]}} ---------- */
// ponytail: las entradas de sesiones viejas no se purgan; son unos bytes por sesión etiquetada.

function tagsPath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "session-tags.json");
}

function loadTags() {
  try {
    return JSON.parse(fs.readFileSync(tagsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function tagEntry(tags, sessionId) {
  if (!UUID_RE.test(String(sessionId || ""))) throw new Error("Sesión no válida.");
  tags[sessionId] ||= { add: [], hide: [] };
  return tags[sessionId];
}

function tag(sessionId, url) {
  const link = parseLink(url);
  if (!link) throw new Error("No reconozco esa URL: pega la de una MR, issue o epic (o una PR de GitHub).");
  const tags = loadTags();
  const entry = tagEntry(tags, sessionId);
  entry.hide = entry.hide.filter((k) => k !== link.key);
  if (!entry.add.includes(link.url)) entry.add.push(link.url);
  fs.writeFileSync(tagsPath(), JSON.stringify(tags, null, 2));
  return link;
}

// Quita un badge: si era manual se borra; si era inferido se oculta para esa sesión.
function untag(sessionId, key) {
  if (typeof key !== "string" || key.length > 500) throw new Error("Badge no válido.");
  const tags = loadTags();
  const entry = tagEntry(tags, sessionId);
  const before = entry.add.length;
  entry.add = entry.add.filter((u) => parseLink(u)?.key !== key);
  if (entry.add.length === before && !entry.hide.includes(key)) entry.hide.push(key);
  fs.writeFileSync(tagsPath(), JSON.stringify(tags, null, 2));
}

module.exports = { list, tag, untag, parseLink, scanTranscript, hostFromChain, lastTurn, sessionActivity };
