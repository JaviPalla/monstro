"use strict";

/**
 * "Probar en local" (ficha de Agents): qué proyectos de una sesión se pueden levantar en ESTE Mac,
 * con qué comando, en qué puerto y contra qué APIs locales apuntan los fronts.
 *
 * Forma de un ítem del plan (lo que consume el renderer):
 *   { project, name, kind, dir, branch, port, url, openUrl, pointsTo, needs, warnings, blocked }
 *   - kind:     "api" | "front", y null en un proyecto que no está en el catálogo (siempre `blocked`).
 *   - needs:    cada requisito que FALTA (etiqueta corta al pintarlo: "dotnet", "pnpm", "node_modules"…).
 *   - warnings: qué hacer con cada `need` + avisos que no son requisitos (CORS, puerto movido).
 *   - blocked:  motivo si arrancar no tendría sentido (sin .env, sin Docker, sin node_modules); null si se puede.
 *
 * `needs`, `warnings`, `blocked` y los `skipped[].reason` de localRun:start viajan SIEMPRE como
 * `{ code, ...params }`: main no arma frases (la UI puede estar en inglés). Ver CODES más abajo.
 *
 * Sin electron (solo builtins + sessions.shellQuote) → `node scripts/test-local-run.js` lo prueba con node.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const dns = require("dns").promises;
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { shellQuote } = require("./sessions");

const pexec = promisify(execFile);

const OHC = "OpenSaludGroup/openhealthcareapi";
const NOTIFICATIONS = "OpenSaludGroup/microservices/notifications_api";
const USERMANAGEMENT = "OpenSaludGroup/microservices/usermanagement_api";

// Clave de `pointsTo`: cómo llama un front a la API que va a apuntar a tu máquina.
const POINTS_TO_KEY = { [OHC]: "api", [NOTIFICATIONS]: "notifications" };

// Lo que ESTE Mac sabe levantar. `subdir` = carpeta donde se abre la pestaña y corre el comando (en las
// APIs .NET, la del csproj de arranque: en la raíz solo hay un .sln y `dotnet run` no elige proyecto por
// ti); `envFile` va relativo a la raíz del repo porque no siempre cae dentro de ese subdir.
const CATALOG = {
  [OHC]: {
    name: "OpenHealthcare API",
    kind: "api",
    order: 1,
    subdir: "openhealthcareapi",
    envFile: "openhealthcareapi/.env",
    profile: "openhealthcareapi",
    port: 44381,
    scheme: "https",
    host: "localhost",
    openPath: "/swagger",
    healthPath: "/health",
    expect: "Healthy",
  },
  [USERMANAGEMENT]: {
    name: "UserManagement API",
    kind: "api",
    order: 2,
    subdir: "UserManagement",
    envFile: "UserManagement/.env",
    profile: "UserManagement",
    port: 5001,
    scheme: "https",
    host: "localhost",
    openPath: "/swagger",
    healthPath: "/health",
    expect: "Healthy",
  },
  [NOTIFICATIONS]: {
    name: "Notifications API",
    kind: "api",
    order: 3,
    // El script comprueba Docker, levanta LocalStack + Mongo y arranca el perfil **Local**. Nunca el
    // perfil Development: ese consume las colas SQS del dev compartido y manda emails/WhatsApp de verdad.
    script: "./run-local.sh",
    subdir: "",
    envFile: "API-Notifications/.env",
    needsDocker: true,
    // run-local.sh no acepta puerto: si el 5002 está cogido, reutiliza la API que ya escuche ahí.
    fixedPort: true,
    port: 5002,
    scheme: "https",
    host: "localhost",
    openPath: "/scalar/v1",
    healthPath: "/health",
    expect: "Healthy",
  },
  "OpenSaludGroup/openhealthcare-launcher": {
    name: "Launcher",
    kind: "front",
    order: 4,
    subdir: "",
    port: 8080,
    scheme: "https",
    host: "localdesarrollo.opensalud.es",
    // El shell manda sobre .env.local y .env; `development` deja en el dev compartido todo lo que no levantemos.
    env: { LOCAL_ENVIRONMENT: "development" },
    apiVars: { [OHC]: "LOCAL_ENV_API", [NOTIFICATIONS]: "LOCAL_ENV_NOTIFICATIONS" },
    // Los certs de mkcert son locales y están en .gitignore: un worktree nuevo no los trae y sin ellos
    // el dev server https no levanta.
    localFiles: ["certs"],
  },
  "OpenSaludGroup/dashboard": {
    name: "Dashboard",
    kind: "front",
    order: 5,
    subdir: "",
    port: 8081,
    scheme: "http",
    host: "localdashboard.opensalud.es",
    devArgs: ["--host"],
    env: {},
    apiVars: {},
    warn: { code: "dashboard-no-override" },
  },
  "OpenSaludGroup/landing-profesionales": {
    name: "Landing profesionales",
    kind: "front",
    order: 6,
    subdir: "nuxt",
    port: 3000,
    scheme: "http",
    // En localhost a propósito: su tenant sale de la cabecera Host.
    host: "localhost",
    env: {},
    apiVars: { [OHC]: "API_LOCAL_DOMAIN" },
    warn: { code: "landing-cors" },
  },
};

/**
 * Códigos que viajan al renderer. Lista corta y estable: uno nuevo aquí necesita su texto en
 * renderer/app/sessions-local.js (LR_TEXT) y su traducción EN en renderer/app/i18n.js.
 * `scripts/test-local-run.js` comprueba que los tres lados no se separen.
 *
 * needs      env-file · dotnet · dev-certs · docker · node-modules · pnpm · hosts-entry {host}
 * warnings   dashboard-no-override · landing-cors · dotnet-missing · dev-certs-missing ·
 *            pnpm-missing · hosts-missing {host} · fixed-port-busy {port} ·
 *            port-moved {defaultPort, port} · new-worktree-env {branch, file} ·
 *            new-worktree-env-copy {branch, file} · env-copy {file} ·
 *            new-worktree-modules {branch} · mr-branch-unknown {iid} · worktree-failed {branch, error}
 * blocked    env-missing {file} · docker-down · node-modules-missing · node-modules-worktree ·
 *            no-free-port {from, to} · windows-only {name, iis} · nuget-library {name} · flutter ·
 *            not-in-catalogue · no-clone · no-local-dir
 * skipped    not-in-session · no-plan · dir-gone {dir} · launch-failed {error} (+ cualquier `blocked`)
 *
 * Los dos últimos grupos los emite también src/ipc/local-run.js (no-clone, mr-branch-unknown,
 * worktree-failed y los skipped).
 */

// Proyectos que NO se pueden levantar aquí, con su motivo (mejor que un "no sé arrancarlo" genérico).
const BLOCKED = {
  "OpenSaludGroup/opensalud": { code: "windows-only", name: "Ouicare", iis: true },
  "OpenSaludGroup/webjob": { code: "windows-only", name: "Webjob" },
  "OpenSaludGroup/opensalud_mobile_app": { code: "flutter" },
  "libraries/JWTToken": { code: "nuget-library", name: "JWTToken" },
  "libraries/middlewares": { code: "nuget-library", name: "middlewares" },
};

const UNKNOWN = { code: "not-in-catalogue" };
const PORT_TRIES = 20;
const PROBE_MS = 2500;
// Margen antes de dar por caído lo recién arrancado: el primer `dotnet run` compila la solución entera.
const STARTING_MS = { api: 180000, front: 60000 };

const lookup = (project) => CATALOG[project] || null;
// Copia: el motivo viaja al renderer y no interesa compartir el objeto del catálogo entre ítems.
const blockedReason = (project) => (CATALOG[project] ? null : { ...(BLOCKED[project] || UNKNOWN) });
const baseUrl = (def, port) => `${def.scheme}://${def.host}:${port}`;
// Carpeta donde se abre la pestaña: la raíz del repo/worktree o el subdirectorio del proyecto.
const runDir = (base, def) => (def.subdir ? path.join(base, def.subdir) : base);

/* ---------- comando que se teclea en la pestaña de Ghostty ---------- */

function checkedPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Puerto no válido: ${port}`);
  return value;
}

// Entorno del front: lo suyo fijo + un override por cada API que SÍ vayamos a levantar. Lo que no
// levantamos se queda donde diga LOCAL_ENVIRONMENT (dev compartido).
function frontEnv(def, pointsTo = {}) {
  const env = { ...(def.env || {}) };
  for (const [project, name] of Object.entries(def.apiVars || {})) {
    const url = pointsTo[POINTS_TO_KEY[project]];
    if (url) env[name] = url;
  }
  return env;
}

function buildCommand(def, { port, pointsTo = {} } = {}) {
  const value = checkedPort(port);
  if (def.script) return def.script;
  if (def.kind === "api") return `dotnet run --launch-profile ${shellQuote(def.profile)} -- --urls ${shellQuote(baseUrl(def, value))}`;
  const prefix = Object.entries(frontEnv(def, pointsTo))
    .map(([key, val]) => `${key}=${shellQuote(val)}`)
    .join(" ");
  const args = ["dev", "--port", String(value), ...(def.devArgs || [])].join(" ");
  // `nvm use` es una función del shell (y el .nvmrc puede estar en la raíz del repo: nvm sube por el
  // árbol), por eso todo esto se TECLEA en tu shell en vez de lanzarse como proceso suelto.
  return `nvm use && ${prefix ? `${prefix} ` : ""}pnpm ${args}`;
}

/* ---------- puertos ---------- */

// Bind al comodín (sin host), no a 127.0.0.1: en macOS, con un vite escuchando en `*:8080` (IPv6), el
// bind a 127.0.0.1 SÍ funciona y daríamos por libre un puerto ocupado — pasó de verdad con el launcher.
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port });
  });
}

// Segunda vuelta por si el bind cuela igualmente (SO_REUSEADDR): si alguien acepta conexión en el
// loopback, ese puerto está cogido.
function connects(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// "Libre" = se puede escuchar en él y nadie contesta ahí. Un worktree y tu propio clon comparten el
// puerto por defecto, así que lo normal es que el segundo se corra al siguiente hueco.
async function portFree(port) {
  if (!(await canBind(port))) return false;
  return !(await connects(port, "127.0.0.1")) && !(await connects(port, "::1"));
}

async function freePort(start, taken = new Set()) {
  for (let port = start; port < start + PORT_TRIES; port++) {
    if (taken.has(port)) continue;
    if (await portFree(port)) return port;
  }
  return null;
}

/* ---------- preflight: se comprueba de verdad, no se supone ---------- */

// El main lanzado desde Finder no hereda tu PATH (mismo motivo que claudeCliPath en src/ai.js): todo se
// comprueba dentro de un shell de login.
const runInShell = (command, timeout = 10000) => pexec("/bin/sh", ["-lc", command], { timeout }).then(() => true, () => false);

// nvm/corepack viven en el rc INTERACTIVO, que `sh -lc` no lee: segundo intento con tu shell.
async function hasBinary(name) {
  const command = `command -v ${name}`;
  if (await runInShell(command)) return true;
  const shell = process.env.SHELL;
  if (!shell || shell === "/bin/sh") return false;
  return pexec(shell, ["-lic", command], { timeout: 10000 }).then(() => true, () => false);
}

const TOOLS_TTL_MS = 30000;
let toolsCache = { at: 0, value: null };

async function tools() {
  if (toolsCache.value && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.value;
  const [dotnet, pnpm, docker, devCerts] = await Promise.all([
    hasBinary("dotnet"),
    hasBinary("pnpm"),
    runInShell("docker info", 15000),
    runInShell("dotnet dev-certs https --check", 20000),
  ]);
  toolsCache = { at: Date.now(), value: { dotnet, pnpm, docker, devCerts } };
  return toolsCache.value;
}

// ¿El host del front apunta a esta máquina? Si no, hay que tocar /etc/hosts, y eso pide sudo: Monstro
// solo da la línea exacta.
async function resolvesLocal(host) {
  if (host === "localhost") return true;
  try {
    const found = await dns.lookup(host, { all: true });
    return found.some((a) => a.address === "127.0.0.1" || a.address === "::1");
  } catch {
    return false;
  }
}

const hostsLineFor = (hosts) => (hosts.length ? `127.0.0.1 ${[...new Set(hosts)].join(" ")}` : null);

// Requisitos de un ítem: `needs` lo que falta, `warnings` qué hacer, `blocked` si arrancar no tiene sentido.
async function preflight(def, { base, dir, newWorktree, clone } = {}) {
  const needs = [];
  const warnings = [];
  let blocked = null;
  let needsHosts = false;
  const tool = await tools();
  if (def.warn) warnings.push(def.warn);
  if (def.kind === "api") {
    // El .env está en .gitignore: un worktree recién creado NUNCA lo trae. Si está en tu clon no es
    // problema tuyo: lo copia el arranque (copyLocalFiles). Solo bloquea si tampoco está allí.
    if (!fs.existsSync(path.join(base, def.envFile))) {
      if (copiableFrom(clone, base, def.envFile)) {
        warnings.push({ code: "env-copy", file: def.envFile });
      } else {
        needs.push({ code: "env-file", file: def.envFile });
        blocked = { code: "env-missing", file: def.envFile };
      }
    }
    if (!tool.dotnet) {
      needs.push({ code: "dotnet" });
      warnings.push({ code: "dotnet-missing" });
    }
    if (!tool.devCerts) {
      needs.push({ code: "dev-certs" });
      warnings.push({ code: "dev-certs-missing" });
    }
    if (def.needsDocker && !tool.docker) {
      needs.push({ code: "docker" });
      blocked = { code: "docker-down" };
    }
  } else {
    if (!fs.existsSync(path.join(dir, "node_modules"))) {
      needs.push({ code: "node-modules" });
      blocked = newWorktree ? { code: "node-modules-worktree" } : { code: "node-modules-missing" };
    }
    if (!tool.pnpm) {
      needs.push({ code: "pnpm" });
      warnings.push({ code: "pnpm-missing" });
    }
    if (!(await resolvesLocal(def.host))) {
      needsHosts = true;
      needs.push({ code: "hosts-entry", host: def.host });
      warnings.push({ code: "hosts-missing", host: def.host });
    }
  }
  return { needs, warnings, blocked, needsHosts };
}

/* ---------- ficheros locales que git ignora ---------- */

// Un worktree nuevo no trae lo que está en .gitignore, y sin ello el proyecto no arranca: el `.env` con
// las credenciales de Secrets Manager de cada API, los certs de mkcert del launcher. Son ficheros tuyos y
// van a una ruta ignorada del mismo repo, así que los copia Monstro en vez de mandarte a hacerlo a mano.
const localFilesOf = (def) => def.localFiles || (def.envFile ? [def.envFile] : []);

const copiableFrom = (clone, base, rel) => Boolean(clone && clone !== base && fs.existsSync(path.join(clone, rel)));

// Solo del clon al worktree, solo si allí falta: nunca pisa un fichero que ya esté. Devuelve lo copiado.
function copyLocalFiles({ project, base, clone } = {}) {
  const def = CATALOG[project];
  const copied = [];
  if (!def || !base || !clone || clone === base) return copied;
  for (const rel of localFilesOf(def)) {
    const to = path.join(base, rel);
    if (fs.existsSync(to) || !copiableFrom(clone, base, rel)) continue;
    const from = path.join(clone, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    // Un .env suele ir en 0600: cpSync no siempre arrastra los permisos y no vamos a abrirlo de más.
    const stat = fs.statSync(from);
    if (stat.isFile()) fs.chmodSync(to, stat.mode & 0o777);
    copied.push(rel);
  }
  return copied;
}

/* ---------- plan ---------- */

// Orden del plan: APIs antes que fronts (los fronts necesitan sus puertos), lo no arrancable al final,
// y dentro de cada grupo el `order` del catálogo — así la lista no baila según cómo venga la sesión.
const rank = (project) => (CATALOG[project]?.kind === "api" ? 0 : CATALOG[project] ? 1 : 2);
const orderOf = (project) => CATALOG[project]?.order ?? 99;

// Ítem de un proyecto que no se va a arrancar: fuera del catálogo, o sin clon donde hacerlo.
function blockedItem(entry, def, blocked) {
  return {
    project: entry.project,
    name: def?.name || entry.project.split("/").pop(),
    kind: def?.kind || null,
    dir: null,
    branch: entry.branch || null,
    port: null,
    url: null,
    openUrl: null,
    pointsTo: {},
    needs: [],
    warnings: [...(entry.warnings || [])],
    blocked,
  };
}

/**
 * entries: [{ project, base, branch, newWorktree, blocked?, warnings? }] ya resueltos por el IPC (main
 * nunca se fía de rutas que vengan del renderer); `base` es la raíz del repo o del worktree. Devuelve
 * { hostsLine, items, plans }; `plans` lleva el comando y la sonda, que no viajan al renderer.
 */
async function buildPlan(entries, { healthPaths = {}, healthExpect = {} } = {}) {
  const ordered = [...entries].sort((a, b) => rank(a.project) - rank(b.project) || orderOf(a.project) - orderOf(b.project));
  const items = [];
  const tail = []; // lo que no se puede arrancar va al final de la lista
  const plans = new Map();
  const rows = [];
  const taken = new Set();
  for (const entry of ordered) {
    const def = lookup(entry.project);
    const why = entry.blocked || blockedReason(entry.project) || (entry.base ? null : { code: "no-local-dir" });
    if (why) {
      tail.push(blockedItem(entry, def, why));
      continue;
    }
    const port = def.fixedPort ? def.port : await freePort(def.port, taken);
    if (port) taken.add(port);
    const dir = runDir(entry.base, def);
    rows.push({ entry, def, port, dir, check: await preflight(def, { ...entry, dir }) });
  }
  // Un front solo apunta a las APIs del plan que de verdad se van a poder arrancar.
  const pointsTo = {};
  for (const { entry, def, port, check } of rows) {
    const key = POINTS_TO_KEY[entry.project];
    if (key && port && !check.blocked) pointsTo[key] = baseUrl(def, port);
  }
  const hosts = [];
  for (const { entry, def, port, dir, check } of rows) {
    const warnings = [...(entry.warnings || []), ...check.warnings];
    const finalPort = port || def.port;
    let blocked = check.blocked;
    if (!port) blocked = blocked || { code: "no-free-port", from: def.port, to: def.port + PORT_TRIES - 1 };
    if (def.fixedPort && !(await portFree(finalPort))) warnings.push({ code: "fixed-port-busy", port: finalPort });
    else if (finalPort !== def.port) warnings.push({ code: "port-moved", defaultPort: def.port, port: finalPort });
    // Lo que va en .gitignore (.env, node_modules) NO viaja a un worktree nuevo: avisamos antes de que
    // el arranque se lo encuentre (al arrancar se replanifica ya sobre el worktree real).
    // Los códigos van siempre literales (nunca en un ternario dentro de `code:`): scripts/test-local-run.js
    // los saca con un rg del fuente para comprobar que el renderer los traduce todos.
    if (entry.newWorktree && def.kind !== "api") {
      warnings.push({ code: "new-worktree-modules", branch: entry.branch });
    } else if (entry.newWorktree && copiableFrom(entry.clone, entry.base, def.envFile)) {
      warnings.push({ code: "new-worktree-env-copy", branch: entry.branch, file: def.envFile });
    } else if (entry.newWorktree) {
      warnings.push({ code: "new-worktree-env", branch: entry.branch, file: def.envFile });
    }
    if (check.needsHosts) hosts.push(def.host);
    const url = baseUrl(def, finalPort);
    const item = {
      project: entry.project,
      name: def.name,
      kind: def.kind,
      dir,
      branch: entry.branch || null,
      port: finalPort,
      url,
      openUrl: `${url}${def.openPath || ""}`,
      pointsTo: def.kind === "front" ? pointsToFor(def, pointsTo) : {},
      needs: check.needs,
      warnings,
      blocked,
    };
    items.push(item);
    plans.set(entry.project, {
      def,
      item,
      base: entry.base,
      command: buildCommand(def, { port: finalPort, pointsTo }),
      // La ruta y el texto de la sonda salen de config.environments (los mismos que Entornos usa
      // contra dev/staging); el catálogo solo pone el respaldo.
      probeUrl: `${url}${healthPaths[entry.project] || def.healthPath || "/"}`,
      expect: healthExpect[entry.project] || def.expect || null,
    });
  }
  return { hostsLine: hostsLineFor(hosts), items: [...items, ...tail], plans };
}

// Solo las APIs que este front sabe redirigir y que además entran en el plan.
function pointsToFor(def, pointsTo) {
  const out = {};
  for (const project of Object.keys(def.apiVars || {})) {
    const key = POINTS_TO_KEY[project];
    if (key && pointsTo[key]) out[key] = pointsTo[key];
  }
  return out;
}

/* ---------- lo que se ha arrancado en esta ejecución ---------- */

const started = new Map(); // project → { url, openUrl, dir, port, kind, probeUrl, expect, startedAt }

const remember = (project, info) => started.set(project, { ...info, startedAt: Date.now() });

// Sonda corta que nunca lanza: las APIs van por https con el certificado de desarrollo (autofirmado).
function probe(url, expect) {
  return new Promise((resolve) => {
    let request;
    try {
      const mod = url.startsWith("https:") ? https : http;
      request = mod.get(url, { rejectUnauthorized: false, timeout: PROBE_MS, headers: { "User-Agent": "monstro-app" } }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        if (!expect || !ok) {
          res.resume();
          resolve(ok);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { if (body.length < 8192) body += chunk; });
        res.on("end", () => resolve(body.includes(expect)));
        res.on("error", () => resolve(false));
      });
    } catch {
      resolve(false);
      return;
    }
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function status() {
  return Promise.all([...started.entries()].map(async ([project, info]) => {
    const up = await probe(info.probeUrl, info.expect);
    const margin = STARTING_MS[info.kind] || STARTING_MS.front;
    return {
      project,
      url: info.url,
      openUrl: info.openUrl,
      state: up ? "up" : Date.now() - info.startedAt < margin ? "starting" : "down",
      since: info.startedAt,
    };
  }));
}

module.exports = {
  copyLocalFiles,
  CATALOG,
  BLOCKED,
  UNKNOWN,
  lookup,
  blockedReason,
  baseUrl,
  runDir,
  buildCommand,
  frontEnv,
  portFree,
  freePort,
  hostsLineFor,
  preflight,
  buildPlan,
  probe,
  remember,
  started,
  status,
};
