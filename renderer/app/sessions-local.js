"use strict";

/* ============ "Probar en local": levantar en tu Mac los proyectos de una sesión ============ */
// Bloque de la ficha (sessions-view.js). Main mira las MRs y los worktrees de la sesión y dice qué proyectos
// tocan, con qué rama, en qué puerto, con qué URL y a qué apuntan (`localRun:plan`); tú marcas los que
// quieras y "Levantar N" abre una pestaña de Ghostty por proyecto (`localRun:start`). A partir de ahí el
// panel pasa a modo estado y pregunta cada 3 s quién responde ya (`localRun:status`).
// Monstro NO toca /etc/hosts: si hace falta una línea, se enseña con su botón de copiar y la pones tú con sudo.
// Todo va por IPC, así que si el backend no está el panel enseña su error y la ficha sigue funcionando igual.
const LR_POLL_MS = 3000;
const LR_KIND_LABEL = { api: "API", front: "Front" };
const LR_KIND_ICON = { api: "server", front: "app-window" };
// A qué apunta un proyecto levantado (pointsTo); las claves son las del contrato, el texto se traduce al pintar.
const LR_POINTS_LABEL = { api: "API", notifications: "Notificaciones" };
// Estado de un proyecto → [clase del punto, texto]. El texto se traduce al pintar (como LINK_STATE).
const LR_STATE = { up: ["svl-up", "Listo"], starting: ["svl-starting", "Levantando…"], down: ["svl-down", "No responde"] };
// Lo único que abre `shell:open` (src/ipc/system.js): https y unas pocas URLs locales. Lo demás se copia,
// porque openExternal lo ignoraría en silencio y el botón parecería roto.
const LR_OPENABLE = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+\.opensalud\.(es|mx))(:\d{1,5})?(\/|$))/i;
// Main NUNCA manda frases: `needs`, `warnings`, `blocked` y los `skipped[].reason` vienen como
// `{ code, ...params }` y el texto se arma aquí. La lista de códigos vive en src/local-run.js; un código
// nuevo necesita su entrada aquí y su traducción EN en i18n.js (scripts/test-local-run.js lo vigila).
// Los nombres de herramienta y de fichero (dotnet, pnpm, node_modules, .env) no se traducen.
const LR_TEXT = {
  // --- needs: etiqueta corta de lo que falta ---
  "env-file": () => ".env",
  dotnet: () => "dotnet",
  "dev-certs": () => t("certificado https"),
  docker: () => "Docker",
  "node-modules": () => "node_modules",
  pnpm: () => "pnpm",
  "hosts-entry": (p) => t("{host} en /etc/hosts", p),
  // --- warnings: lo que hay que hacer, o lo que va a pasar igualmente ---
  "dashboard-fixed-api": (p) => t("El dashboard en local va siempre a {url} (lo fija su domains.json, no hay variable que lo mueva) y sus notificaciones a producción.", p),
  "override-file": (p) => t("Lo dejo también en su {file} (solo en este worktree, git lo ignora): así un pnpm dev que lance el agente apunta a la misma API.", p),
  "landing-cors": () => t("La landing corre en localhost: el CORS de la API (solo *.opensalud.es|mx) bloquearía sus llamadas a una API local desde el navegador."),
  "dotnet-missing": () => t("No encuentro el SDK de dotnet en tu PATH."),
  "dev-certs-missing": () => t("El certificado https de desarrollo no está listo: `dotnet dev-certs https --trust`."),
  "pnpm-missing": () => t("No encuentro pnpm en tu PATH."),
  "hosts-missing": (p) => t("{host} no resuelve a 127.0.0.1: añade la línea de /etc/hosts (necesita sudo, Monstro no lo toca).", p),
  "fixed-port-busy": (p) => t("El puerto {port} ya está ocupado: run-local.sh reutilizará la API que esté escuchando ahí.", p),
  "port-moved": (p) => t("El puerto por defecto ({defaultPort}) está ocupado, así que arranca en el {port}.", p),
  "new-worktree-env": (p) => t("El worktree de {branch} se creará al arrancar, y el {file} no viaja con él (cópialo desde tu clon).", p),
  "new-worktree-env-copy": (p) => t("El worktree de {branch} se creará al arrancar y le copiaré tu {file}.", p),
  "env-copy": (p) => t("Aquí no está el {file}, así que lo copio de tu clon al arrancar.", p),
  "new-worktree-modules": (p) => t("El worktree de {branch} se creará al arrancar, y node_modules no viaja con él (puede hacer falta pnpm install).", p),
  "mr-branch-unknown": (p) => t("No he podido resolver la rama de la MR !{iid}: arranco tu clon tal cual.", p),
  "worktree-failed": (p) => t("No he podido crear el worktree de {branch}: {error}", p),
  // --- blocked: por qué arrancar no tendría sentido ---
  "env-missing": (p) => t("Falta {file}: sin él la API no puede leer sus credenciales de AWS Secrets Manager. Cópialo desde tu clon.", p),
  "docker-down": () => t("Docker no responde: run-local.sh necesita LocalStack y Mongo para el perfil Local."),
  "node-modules-missing": () => t("Faltan las dependencias: `pnpm install` en esa carpeta."),
  "node-modules-worktree": () => t("El worktree todavía no tiene node_modules (no viajan al crearlo): haz `pnpm install` ahí antes de arrancar."),
  "no-free-port": (p) => t("No hay ningún puerto libre entre el {from} y el {to}.", p),
  "windows-only": (p) => (p.iis ? t("{name} es .NET Framework: solo arranca en Windows con IIS.", p) : t("{name} es .NET Framework: solo arranca en Windows.", p)),
  "nuget-library": (p) => t("{name} es una librería NuGet: no es un servicio que se arranque.", p),
  flutter: () => t("Es la app Flutter: se prueba en un emulador, no como servicio local."),
  "not-in-catalogue": () => t("No sé arrancar este proyecto en local."),
  "no-clone": () => t("No tienes un clon de ese proyecto en tu carpeta de repos."),
  "no-local-dir": () => t("No tengo una carpeta local de ese proyecto donde arrancarlo."),
  // --- skipped: por qué main no ha levantado un proyecto (además de cualquier `blocked`) ---
  "not-in-session": () => t("Ese proyecto ya no sale en esta sesión."),
  "no-plan": () => t("No sé arrancar ese proyecto en local."),
  "dir-gone": (p) => t("La carpeta {dir} ya no existe.", p),
  "launch-failed": (p) => t("No se ha podido abrir la pestaña: {error}", p),
};

// Un código que no conozca sale tal cual (como skipReason): nunca en blanco.
function lrText(reason) {
  if (!reason) return "";
  if (typeof reason === "string") return reason;
  return LR_TEXT[reason.code]?.(reason) || reason.code || "";
}

// Estado del panel por sesión, dentro de sessionsUi como viewTab/viewOpen: el repintado del poll (10 s) no
// puede perder ni lo abierto, ni lo marcado, ni el estado de lo levantado.
// { open, mode: "plan"|"status", loading, pending, plan, picked: Set, started: [{project, url}], status, v }
function lrEntry(id) {
  let entry = sessionsUi.localRun.get(id);
  if (!entry) sessionsUi.localRun.set(id, (entry = { open: false, mode: "plan", loading: false, plan: null, picked: null, started: null, status: null, error: null, v: 0 }));
  return entry;
}

// Versión del panel para svKey: sin ella el poll repintaría encima de lo que acabas de marcar (o al revés,
// no repintaría nunca al llegar el estado nuevo).
function lrKey(id) {
  const entry = sessionsUi.localRun.get(id);
  if (!entry?.open) return "0";
  return `${entry.mode}${entry.loading ? "…" : ""}${entry.v}|${[...(entry.picked || [])].sort().join(",")}|${JSON.stringify(entry.targets || {})}`;
}

// Tiene sentido ofrecerlo si la sesión toca MRs/PRs o si alguno de sus repos está clonado aquí.
const lrAvailable = (s) => s.links.some((l) => l.kind === "mr" || l.kind === "pr") || s.repos.some((r) => r.dir);
const lrRunnable = (item) => !item.blocked && !(item.needs || []).length;

/* ---------- el plan (localRun:plan) ---------- */

function lrLoadPlan(s) {
  const entry = lrEntry(s.sessionId);
  if (entry.pending) return entry.pending;
  entry.loading = true;
  entry.error = null;
  entry.v++;
  renderSessionView(true);
  entry.pending = Promise.resolve()
    // Sin backend todavía (el preload no lo expone) el TypeError no dice nada útil: mejor decirlo en cristiano.
    .then(() => (typeof window.monstro.localRunPlan === "function" ? window.monstro.localRunPlan(s.sessionId) : Promise.reject(new Error(t("esta versión de Monstro todavía no sabe levantar proyectos")))))
    .then(
      (plan) => {
        entry.plan = { hostsLine: plan?.hostsLine || null, items: Array.isArray(plan?.items) ? plan.items : [] };
        entry.picked = new Set(entry.plan.items.filter(lrRunnable).map((i) => i.project));
        entry.error = null;
      },
      (err) => {
        console.error("[localRun:plan]", err);
        entry.plan = null;
        entry.error = ipcMessage(err);
      },
    )
    .finally(() => {
      entry.loading = false;
      entry.pending = null;
      entry.v++;
      renderSessionView(true);
    });
  return entry.pending;
}

/* ---------- pintado ---------- */

// La línea de /etc/hosts va una sola vez arriba del panel: Monstro no la escribe, solo te la deja copiada.
function lrHostsHtml(line) {
  return `
    <div class="svl-hosts">
      <p>${esc(t("Añade esta línea a /etc/hosts con sudo (Monstro no toca ese fichero):"))}</p>
      <div class="svl-hosts-line"><code>${esc(line)}</code><button class="mini-btn" data-ss="local-copy" data-text="${esc(line)}">${esc(t("Copiar"))}</button></div>
    </div>`;
}

function lrPointsHtml(points) {
  const parts = Object.entries(points || {})
    .filter(([, url]) => url)
    .map(([key, url]) => `${t(LR_POINTS_LABEL[key] || key)} → ${url}`);
  return parts.length ? `<span class="svl-points">${esc(t("apunta a"))} ${esc(parts.join(" · "))}</span>` : "";
}

const lrShortUrl = (url) => String(url || "").replace(/^https?:\/\//, "");

function lrKindHtml(item) {
  return item?.kind ? `<span class="svl-kind svl-k-${esc(item.kind)}">${icon(LR_KIND_ICON[item.kind])}${esc(LR_KIND_LABEL[item.kind] || item.kind)}</span>` : "";
}

// URL local: la de la API marcada en este plan, o la que ya está levantada (si la desmarcas, esa). Sin
// ninguna, Dev.
function lrChoice(entry, item, target) {
  const planned = !target.running && Boolean(entry.picked?.has(target.apiProject));
  const url = target.running || planned ? target.local : target.fallback;
  const wanted = entry.targets?.[item.project]?.[target.key] ?? target.choice;
  return { url, choice: url && wanted === "local" ? "local" : "dev" };
}

// Por cada API del front, Local o Dev, cada opción con la URL exacta a la que irá.
function lrTargetsHtml(item, entry) {
  const rows = item.targets.map((target) => {
    const { url, choice } = lrChoice(entry, item, target);
    const already = target.running || (url && url === target.fallback);
    const local = url ? `${url}${already ? ` · ${t("ya levantada")}` : ""}` : t("no levantada");
    const option = (value, label, text, disabled) => `<option value="${value}"${choice === value ? " selected" : ""}${disabled ? " disabled" : ""}>${esc(label)} · ${esc(text)}</option>`;
    return `<span class="svl-target">${esc(t(LR_POINTS_LABEL[target.key] || target.key))} ${icon("arrow-right")}`
      + `<select data-project="${esc(item.project)}" data-key="${esc(target.key)}">${option("local", t("Local"), local, !url)}${target.dev ? option("dev", t("Dev"), target.dev, false) : ""}</select></span>`;
  });
  return `<span class="svl-targets">${rows.join("")}</span>`;
}

// Una fila del plan: qué se levanta, con qué rama y en qué URL. Lo bloqueado va en gris y sin casilla.
function lrPlanRow(item, picked, entry) {
  const blocked = lrText(item.blocked);
  const box = item.blocked
    ? `<span class="svl-box-off" title="${esc(blocked)}">—</span>`
    : `<input type="checkbox" class="svl-box" data-ss="local-pick" data-project="${esc(item.project)}"${picked ? " checked" : ""} />`;
  const meta = [
    item.branch && `<span class="branch">${esc(item.branch)}</span>`,
    item.port && `<span class="svl-port">:${esc(String(item.port))}</span>`,
    item.url && `<span class="svl-url" title="${esc(item.url)}">${esc(item.url)}</span>`,
  ].filter(Boolean).join("");
  const lines = [
    item.blocked && `<span class="svl-blocked">${esc(blocked)}</span>`,
    (item.needs || []).length && `<span class="svl-needs">${esc(t("Te falta: {list}", { list: item.needs.map(lrText).join(" · ") }))}</span>`,
    (item.warnings || []).length && `<span class="svl-warn">${item.warnings.map((w) => esc(lrText(w))).join(" · ")}</span>`,
    item.targets?.length ? lrTargetsHtml(item, entry) : lrPointsHtml(item.pointsTo),
  ].filter(Boolean).join("");
  return `
    <label class="svl-row${item.blocked ? " off" : ""}">
      ${box}
      <span class="svl-main">
        <span class="svl-top"><b>${esc(item.name || item.project)}</b>${lrKindHtml(item)}${meta}</span>
        ${lines}
      </span>
    </label>`;
}

function lrPlanPanel(entry) {
  const items = entry.plan.items;
  if (!items.length) return `<p class="muted">${esc(t("No encuentro proyectos que levantar para esta sesión"))}</p>`;
  const picked = entry.picked || new Set();
  const n = items.filter((i) => !i.blocked && picked.has(i.project)).length;
  return `
    ${entry.plan.hostsLine ? lrHostsHtml(entry.plan.hostsLine) : ""}
    <p class="svl-note">${esc(t("Una pestaña de Ghostty por proyecto, en tu shell y con tus variables."))}</p>
    <div class="svl-rows">${items.map((i) => lrPlanRow(i, picked.has(i.project), entry)).join("")}</div>
    <button class="ss-go-btn" data-ss="local-go"${n ? "" : " disabled"}>${esc(t("Levantar {n}", { n }))}</button>`;
}

// Una fila en marcha: punto de color + estado + su URL. "Abrir" solo si shell:open la va a aceptar.
function lrStatusRow(started, status, item) {
  const [cls, label] = LR_STATE[status?.state] || LR_STATE.starting;
  const url = status?.openUrl || status?.url || started.url || "";
  const action = !url
    ? ""
    : LR_OPENABLE.test(url)
      ? `<button class="mini-btn" data-ss="local-open" data-url="${esc(url)}">${esc(t("Abrir"))}</button>`
      : `<button class="mini-btn" data-ss="local-copy" data-text="${esc(url)}" title="${esc(t("Esta URL no se puede abrir desde Monstro: te la copio"))}">${esc(t("Copiar URL"))}</button>`;
  const since = status?.state === "up" && status.since ? `<span class="muted">${esc(timeAgo(status.since))}</span>` : "";
  return `
    <div class="svl-row svl-st">
      <span class="svl-dot ${cls}"></span>
      <span class="svl-main">
        <span class="svl-top"><b>${esc(item?.name || started.project)}</b>${lrKindHtml(item)}<span class="svl-state">${esc(t(label))}</span>${since}</span>
        ${url ? `<span class="svl-url" title="${esc(url)}">${esc(lrShortUrl(url))}</span>` : ""}
      </span>
      ${action}
    </div>`;
}

function lrStatusPanel(entry) {
  const byProject = new Map((entry.status || []).map((x) => [x.project, x]));
  const itemOf = (project) => (entry.plan?.items || []).find((i) => i.project === project);
  const rows = (entry.started || []).map((x) => lrStatusRow(x, byProject.get(x.project), itemOf(x.project))).join("");
  return `
    <p class="svl-note">${esc(t("Levantándose en Ghostty: aquí ves cuál responde ya."))}</p>
    <div class="svl-rows">${rows}</div>
    <button class="mini-btn" data-ss="local-again">${esc(t("Elegir otros"))}</button>`;
}

function lrPanel(entry) {
  if (entry.loading && !entry.plan) return `<p class="muted sv-loading"><span class="ss-spin"></span>${esc(t("Mirando qué se puede levantar…"))}</p>`;
  if (!entry.plan) {
    return `<p class="muted">${esc(t("No se pudo preparar el arranque local: {err}", { err: entry.error || "?" }))}</p>`
      + `<button class="mini-btn" data-ss="local-run" data-reload="1">${esc(t("Reintentar"))}</button>`;
  }
  const failed = entry.error ? `<p class="svl-needs">${esc(t("No se pudo preparar el arranque local: {err}", { err: entry.error }))}</p>` : "";
  return failed + (entry.mode === "status" ? lrStatusPanel(entry) : lrPlanPanel(entry));
}

// El bloque entero (botón + panel), justo debajo de las vinculadas. Solo GitLab: las MRs y los clones que
// resuelve main son de GitLab.
function localRunBlock(s) {
  if (!isGitlab() || !lrAvailable(s)) return "";
  const entry = sessionsUi.localRun.get(s.sessionId);
  const open = Boolean(entry?.open);
  const head = `<div class="svl-head">
      <button class="mini-btn svl-toggle${open ? " active" : ""}" data-ss="local-run" title="${esc(t("Levanta en tu Mac los proyectos que tocan sus MRs"))}">${esc(t("Probar en local"))}</button>
      ${open ? `<button class="svl-x" data-ss="local-close" title="${esc(t("Cerrar"))}">${icon("x")}</button>` : ""}
    </div>`;
  return `<section class="svl">${head}${open ? `<div class="svl-body">${lrPanel(entry)}</div>` : ""}</section>`;
}

/* ---------- levantar y vigilar ---------- */

function lrStartSummary(started, skipped) {
  const up = started.length === 1 ? t("1 proyecto levantado en Ghostty") : started.length > 1 && t("{n} proyectos levantados en Ghostty", { n: started.length });
  const out = skipped.length && t("Sin levantar: {list}", { list: skipped.map((x) => `${x.project} (${lrText(x.reason)})`).join(", ") });
  return [up, out].filter(Boolean).join(" · ") || t("No se ha levantado nada");
}

async function lrStart(s, el) {
  const entry = lrEntry(s.sessionId);
  const projects = (entry.plan?.items || []).filter((i) => !i.blocked && entry.picked?.has(i.project)).map((i) => i.project);
  if (!projects.length) return;
  el.disabled = true;
  try {
    // Lo que ves en cada selector es lo que se manda (main lo vuelve a validar).
    const targets = {};
    for (const item of entry.plan.items) {
      if (item.targets?.length && projects.includes(item.project)) targets[item.project] = Object.fromEntries(item.targets.map((x) => [x.key, lrChoice(entry, item, x).choice]));
    }
    const result = await window.monstro.localRunStart(s.sessionId, projects, targets);
    const started = result?.started || [];
    const skipped = result?.skipped || [];
    toast(lrStartSummary(started, skipped), started.length ? (skipped.length ? "warn" : "ok") : "err");
    if (!started.length) return;
    Object.assign(entry, { mode: "status", started, status: null, statusJson: "", error: null, v: entry.v + 1 });
    renderSessionView(true);
    lrStartPoll(s.sessionId);
  } finally {
    el.disabled = false;
  }
}

// Un único timer para toda la app: solo hay una ficha abierta a la vez.
let lrTimer = null;

function lrStopPoll() {
  if (lrTimer) clearInterval(lrTimer);
  lrTimer = null;
}

function lrStartPoll(id) {
  lrStopPoll();
  lrTimer = setInterval(() => lrTick(id), LR_POLL_MS);
}

// Se para solo: si la ficha se cerró, se fue a otra sesión o cerraste el panel, no hay nada que refrescar.
async function lrTick(id) {
  const entry = sessionsUi.localRun.get(id);
  if (viewingId() !== id || !entry?.open || entry.mode !== "status") return void lrStopPoll();
  try {
    const all = await window.monstro.localRunStatus();
    const mine = (all || []).filter((x) => entry.started.some((y) => y.project === x.project));
    const json = JSON.stringify(mine);
    if (json === entry.statusJson) return;
    Object.assign(entry, { status: mine, statusJson: json, error: null, v: entry.v + 1 });
  } catch (err) {
    console.error("[localRun:status]", err);
    if (entry.error === ipcMessage(err)) return;
    Object.assign(entry, { error: ipcMessage(err), v: entry.v + 1 });
  }
  renderSessionView();
}

/* ---------- acciones (las reparte onSessionViewAction) ---------- */

async function onLocalRunAction(action, s, el) {
  if (!action.startsWith("local-")) return;
  const entry = lrEntry(s.sessionId);
  switch (action) {
    case "local-run":
      if (el.dataset.reload) {
        lrLoadPlan(s);
        break;
      }
      entry.open = !entry.open;
      entry.v++;
      if (!entry.open) lrStopPoll();
      renderSessionView(true);
      if (!entry.open) break;
      if (!entry.plan && !entry.pending) lrLoadPlan(s);
      if (entry.mode === "status") lrStartPoll(s.sessionId);
      break;
    case "local-close":
      entry.open = false;
      entry.v++;
      lrStopPoll();
      renderSessionView(true);
      break;
    case "local-pick": {
      entry.picked ??= new Set();
      if (!entry.picked.delete(el.dataset.project)) entry.picked.add(el.dataset.project);
      entry.v++;
      renderSessionView(true);
      break;
    }
    case "local-go":
      await lrStart(s, el);
      break;
    case "local-again":
      lrStopPoll();
      Object.assign(entry, { mode: "plan", v: entry.v + 1 });
      renderSessionView(true);
      break;
    case "local-open":
      window.monstro.openExternal(el.dataset.url);
      break;
    case "local-copy":
      copyText(el.dataset.text);
      break;
  }
}

// Selector Local/Dev de un front: se guarda en el estado del panel, como lo marcado.
document.addEventListener("change", (event) => {
  const select = event.target.closest?.(".svl-target select");
  const id = select?.closest("[data-id]")?.dataset.id;
  if (!id) return;
  const entry = lrEntry(id);
  entry.targets ??= {};
  (entry.targets[select.dataset.project] ??= {})[select.dataset.key] = select.value;
  entry.v++;
  renderSessionView(true);
});

// Selftest `sessions-view:<texto>#local`: el panel abierto con su plan ya cargado. SOLO lee (localRun:plan):
// nunca llama a localRun:start.
async function lrSelftestOpen(s) {
  const entry = lrEntry(s.sessionId);
  entry.open = true;
  entry.v++;
  await lrLoadPlan(s);
  detailContent.querySelector(".svl")?.scrollIntoView({ block: "center" });
}
