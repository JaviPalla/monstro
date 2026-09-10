"use strict";

/* ============ panel de sesiones de Claude Code (src/sessions.js), a la izquierda ============ */
// Diseño "Actividad": primero las que te esperan (con lo último que dijo o pidió Claude), luego las que
// trabajan (con la herramienta en curso) y las terminadas de hoy. Click en una tarjeta → su ficha grande
// (resumen, tus peticiones, ficheros y métricas) en el panel de detalle. Al abrirlo el menú se pliega a
// iconos para dejar sitio. Abierto/cerrado se recuerda en localStorage (preferencia de este equipo, no config).
// Poll cada 10 s con el panel abierto y cada minuto cerrado (solo para el contador del botón).
const SESSIONS_STORE_KEY = "monstro:sessionsPane";
const SESSIONS_TICK_MS = 10000;
const SESSIONS_IDLE_TICKS = 6;
const SESSIONS_MAX_LINKS = 6;
const SESSIONS_MAX_WAITING = 4;
const EDITOR_LABEL = { dotnet: "Rider", vue: "VS Code", node: "VS Code" };
const LINK_LABEL = { mr: "!{n}", pr: "PR #{n}", issue: "#{n}", epic: "Epic #{n}" };
const ORIGIN_LABEL = { "claude-vscode": "VS Code", cli: "CLI" };
const HOST_LABEL = { ghostty: "Ghostty", rider: "Rider", vscode: "VS Code · terminal", "vscode-ext": "VS Code", terminal: "Terminal", iterm: "iTerm" };
const HOST_APP_LABEL = { ghostty: "Ghostty", rider: "Rider", vscode: "VS Code", "vscode-ext": "VS Code", terminal: "Terminal", iterm: "iTerm" };
const sessionsPane = $("#sessions-pane");
// Estado del lanzador ("¿Qué quieres hacer?"): vive aquí para sobrevivir a los repintados del poll.
const LAUNCH_EMPTY = { action: null, url: "", prompt: "", dir: null, repo: null, targets: null, busy: false };
const sessionsUi = { data: null, pending: null, tagOpen: new Set(), expanded: new Set(), allWaiting: false, idleOpen: true, finishedOpen: true, ticks: 0, launch: { ...LAUNCH_EMPTY } };

const sessionsOpen = () => !sessionsPane.classList.contains("hidden");
// Electron envuelve los throw del main: "Error invoking remote method 'x': Error: <mensaje>".
const ipcMessage = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
// Sesión cuya ficha enseña el panel de detalle, o null. Se lee del DOM: si una MR u otra vista pisa el
// panel, la ficha deja de estar y el poll ya no la repinta.
const viewingId = () => (detailPane.classList.contains("hidden") ? null : detailContent.querySelector(".sv")?.dataset.id || null);
const selectedClass = (s) => (s.sessionId === viewingId() ? " selected" : "");

// Plegado, el menú solo enseña iconos: cada entrada lleva su nombre como tooltip.
function labelCollapsedNav() {
  document.querySelectorAll("#sidebar .bucket, #sidebar .nav-section").forEach((el) => {
    el.title ||= [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())?.textContent.trim() || "";
  });
}

function toggleSessionsPane(open = !sessionsOpen()) {
  sessionsPane.classList.toggle("hidden", !open);
  // "open" y no "active": las vistas limpian .active de todos los .bucket al navegar.
  $("#sessions-btn").classList.toggle("open", open);
  document.body.classList.toggle("nav-collapsed", open);
  if (open) labelCollapsedNav();
  if (!IS_SELFTEST) {
    try { localStorage.setItem(SESSIONS_STORE_KEY, open ? "1" : "0"); } catch { /* sin storage: no se recuerda */ }
  }
  if (open) {
    if (!detailPane.classList.contains("hidden")) hideDetail(); // el tablero va a pantalla completa
    loadSessions();
  } else if (viewingId()) {
    hideDetail(); // sin panel no hay ficha
  }
}

function loadSessions() {
  sessionsUi.pending ??= window.monstro.sessionsList()
    .then((data) => { sessionsUi.data = data; })
    .catch((err) => console.error("[sessions]", err))
    .finally(() => {
      sessionsUi.pending = null;
      renderSessions();
      renderSessionView();
    });
  return sessionsUi.pending;
}

function initSessions() {
  let open = false;
  try { open = !IS_SELFTEST && localStorage.getItem(SESSIONS_STORE_KEY) === "1"; } catch { /* idem */ }
  toggleSessionsPane(open);
  if (!open) loadSessions();
  setInterval(() => {
    if (document.hidden) return;
    if (!sessionsOpen() && ++sessionsUi.ticks % SESSIONS_IDLE_TICKS) return;
    loadSessions();
  }, SESSIONS_TICK_MS);
}

async function runSessionsSelftest() {
  state.selftestNotified = true;
  try {
    toggleSessionsPane(true);
    await loadSessions();
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest `sessions-mr`: abre la MR de la primera sesión de review, igual que un click en su badge.
async function runSessionsMrSelftest() {
  state.selftestNotified = true;
  await loadSessions();
  const session = (sessionsUi.data || []).find((s) => s.review && s.links.some((l) => l.kind === "mr"));
  state.selftestNotified = false;
  if (!session) return void notifySelftestOnce();
  openSessionLink(session.links.find((l) => l.kind === "mr"), session);
}

// Selftest `sessions-launch`: "Review de MR" resolviendo contra GitLab la primera epic (o tarea, o MR) que
// salga en tus sesiones. Solo lecturas: enseña la lista de MRs y sus clones, no lanza nada.
async function runSessionsLaunchSelftest() {
  state.selftestNotified = true;
  try {
    toggleSessionsPane(true);
    await loadSessions();
    const links = (sessionsUi.data || []).flatMap((s) => s.links);
    const link = ["epic", "issue", "mr"].map((kind) => links.find((l) => l.kind === kind)).find(Boolean);
    Object.assign(sessionsUi.launch, { action: "review", url: link?.url || "" });
    if (link) await findLaunchTargets().catch((err) => toast(ipcMessage(err), "err"));
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest `sessions-view`: la ficha de la sesión con más peticiones, como un click en su tarjeta.
async function runSessionsViewSelftest() {
  state.selftestNotified = true;
  try {
    toggleSessionsPane(true);
    await loadSessions();
    const session = [...(sessionsUi.data || [])].sort((a, b) => b.prompts.length - a.prompts.length)[0];
    if (session) openSessionView(session.sessionId);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

function linkBadge(link) {
  const tip = link.manual ? `${link.project} · ${t("fijado a mano")}` : link.project;
  const done = link.state && link.state !== "OPEN" ? " done" : "";
  return `<span class="ss-badge ss-${link.kind}${link.manual ? " manual" : ""}${done}" title="${esc(tip)}">`
    + `<button class="ss-link" data-ss="link" data-key="${esc(link.key)}">${esc(LINK_LABEL[link.kind].replace("{n}", link.iid))}</button>`
    + `<button class="ss-x" data-ss="hide" data-key="${esc(link.key)}" title="${esc(t("Quitar"))}">×</button></span>`;
}

function linkBadges(s) {
  const links = sessionsUi.expanded.has(s.sessionId) ? s.links : s.links.slice(0, SESSIONS_MAX_LINKS);
  const extra = s.links.length - links.length;
  if (!links.length) return "";
  return `<div class="ss-badges">${links.map(linkBadge).join("")}${extra > 0 ? `<button class="ss-badge ss-more" data-ss="more">+${extra}</button>` : ""}</div>`;
}

function sessionHeader(s) {
  return `<div class="ss-top" title="${esc(s.title)}"><span class="ss-dot"></span><span class="ss-title">${esc(s.title)}</span><span class="ss-time">${esc(timeAgo(s.updatedAt))}</span></div>`;
}

// "Ir a Ghostty / VS Code…" solo si se sabe dónde corre.
function goButton(s) {
  return HOST_APP_LABEL[s.host] ? `<button class="ss-go-btn" data-ss="focus">${esc(t("Ir a {app}", { app: HOST_APP_LABEL[s.host] }))}</button>` : "";
}

function editorButton(s) {
  const editor = EDITOR_LABEL[s.stack] || "VS Code";
  return `<button class="mini-btn" data-ss="open" data-dir="${esc(s.dir || "")}" title="${esc(t("Abrir {p} en {e}", { p: s.dir || "", e: editor }))}">${editor}</button>`;
}

// Lo que se enseña bajo el título: si te espera, qué te pide o qué dijo; si trabaja, qué está haciendo.
function sessionLine(s) {
  if (s.state === "working") {
    return `<div class="ss-activity"><span class="ss-spin"></span><span class="ss-ellip">${esc(s.activity || t("Pensando…"))}</span></div>`;
  }
  const quote = s.waitingFor ? `${t("Necesita tu respuesta")}${s.activity ? `: ${s.activity}` : ""}` : s.excerpt || s.activity;
  return quote ? `<div class="ss-quote"><span class="ss-clamp">${esc(quote)}</span></div>` : "";
}

function sessionCard(s) {
  const meta = [HOST_LABEL[s.host] || ORIGIN_LABEL[s.entrypoint], s.review && t("review de MR"), s.repos.map((r) => r.name).join(", ")].filter(Boolean).join(" · ");
  const tagForm = sessionsUi.tagOpen.has(s.sessionId)
    ? `<form class="ss-tag-form"><input name="url" required placeholder="${esc(t("Pega la URL de una MR, issue o epic"))}" /></form>`
    : "";
  return `
    <div class="ss-card ${s.state}${selectedClass(s)}" data-id="${esc(s.sessionId)}">
      ${sessionHeader(s)}
      <div class="ss-meta">${esc(meta)}</div>
      ${sessionLine(s)}
      ${linkBadges(s)}
      <div class="ss-actions">
        ${goButton(s)}
        ${editorButton(s)}
        <button class="mini-btn" data-ss="add" title="${esc(t("Asociar MR, issue o epic"))}">+</button>
      </div>
      ${tagForm}
    </div>`;
}

// Terminadas = proceso cerrado: fila compacta con Reanudar y sus MRs/epics (una review cerrada puede
// seguir teniendo borradores pendientes en GitLab).
function finishedRow(s) {
  const links = s.links.slice(0, SESSIONS_MAX_LINKS);
  return `
    <div class="ss-done${selectedClass(s)}" data-id="${esc(s.sessionId)}" title="${esc([s.title, s.excerpt].filter(Boolean).join(" · "))}">
      <div class="ss-done-top">
        <span class="ss-dot"></span><span class="ss-ellip">${esc(s.title)}</span>
        <span class="ss-time">${esc(timeAgo(s.updatedAt))}</span>
        <button class="mini-btn" data-ss="resume">${t("Reanudar")}</button>
      </div>
      ${links.length ? `<div class="ss-badges ss-done-links">${links.map(linkBadge).join("")}</div>` : ""}
    </div>`;
}

function sectionHead(kind, label, count, toggle = "", open = true) {
  const chevron = toggle ? `<span class="ss-chevron">${open ? "▾" : "▸"}</span>` : "";
  const tag = toggle ? "button" : "div";
  return `<${tag} class="ss-sec ss-sec-${kind}" ${toggle ? `data-ss="${toggle}"` : ""}>${chevron}<span class="ss-dot"></span>${esc(label)} · ${count}</${tag}>`;
}

function renderSessions() {
  const all = sessionsUi.data || [];
  const waiting = all.filter((s) => s.state === "waiting");
  const working = all.filter((s) => s.state === "working");
  // Abiertas sin nada pendiente (terminal/IDE aún abierto) ≠ terminadas (proceso cerrado).
  const idle = all.filter((s) => s.state === "done");
  const finished = all.filter((s) => s.state === "finished");
  // El contador del botón es lo que pide atención: las que te esperan.
  $("#sessions-count").textContent = waiting.length ? String(waiting.length) : "";
  if (!sessionsOpen()) return;
  // No repintar mientras se escribe una URL: el poll se llevaría el input por delante.
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && sessionsPane.contains(document.activeElement)) return;

  let body = `<div class="ss-empty">${t("Cargando…")}</div>`;
  if (sessionsUi.data && !all.length) body = `<div class="ss-empty">${t("No hay sesiones en las últimas 24 h")}</div>`;
  if (all.length) {
    const shownWaiting = sessionsUi.allWaiting ? waiting : waiting.slice(0, SESSIONS_MAX_WAITING);
    const hiddenWaiting = waiting.length - shownWaiting.length;
    // En el tablero (pantalla completa) cada sección es una rejilla; en la columna, una lista.
    const grid = (items, render) => `<div class="ss-grid">${items.map(render).join("")}</div>`;
    body = [
      waiting.length ? sectionHead("waiting", t("Esperándote"), waiting.length) + grid(shownWaiting, sessionCard) : "",
      hiddenWaiting > 0 ? `<button class="ss-more-link" data-ss="all-waiting">${t("Ver {n} más esperando", { n: hiddenWaiting })}</button>` : "",
      working.length ? sectionHead("working", t("Trabajando"), working.length) + grid(working, sessionCard) : "",
      idle.length ? sectionHead("idle", t("Sin pendientes"), idle.length, "toggle-idle", sessionsUi.idleOpen) + (sessionsUi.idleOpen ? grid(idle, sessionCard) : "") : "",
      finished.length ? sectionHead("finished", t("Terminadas"), finished.length, "toggle-finished", sessionsUi.finishedOpen) + (sessionsUi.finishedOpen ? grid(finished, finishedRow) : "") : "",
    ].join("");
  }
  sessionsPane.innerHTML = `
    <div class="ss-head">
      <strong>${t("Sesiones de Claude")}</strong>
      <span class="ss-sub">${t("{n} vivas", { n: all.filter((s) => s.live).length })}</span>
      <button class="icon-btn ss-close" data-ss="close" title="${esc(t("Cerrar el panel"))}">✕</button>
    </div>
    ${launcherHtml()}
    ${body}`;
}

// MR/PR de un repo configurado → su pestaña de Cambios a pantalla completa (el panel se cierra para dejarle
// sitio); si la sesión es de la skill de review, directo a los borradores que dejó en GitLab. Lo demás
// (issues, epics, repos ajenos) al navegador, y las MRs/PRs ya en su diff.
function openSessionLink(link, session) {
  if (!link) return;
  const isChange = link.kind === "mr" || link.kind === "pr";
  if (isChange && (state.config?.repos || []).includes(link.project)) {
    toggleSessionsPane(false);
    state.focusPendingDrafts = Boolean(session?.review);
    openDetail(link.iid, "changes", link.project);
    return;
  }
  window.monstro.openExternal(isChange ? `${link.url}/${link.kind === "mr" ? "diffs" : "files"}` : link.url);
}

/* ---------- ficha de una sesión: click en su tarjeta → panel de detalle a lo ancho ---------- */

function stateLabel(s) {
  return { waiting: t("Esperándote"), working: t("Trabajando"), done: t("Sin pendientes"), finished: t("Terminada") }[s.state];
}

// Hora de una petición: HH:MM si es de hoy; si no, con el día delante.
function clock(at) {
  if (!at) return "";
  const date = new Date(at);
  const day = date.toDateString() === new Date().toDateString() ? {} : { day: "numeric", month: "short" };
  return date.toLocaleString(LANG, { ...day, hour: "2-digit", minute: "2-digit", hour12: false });
}

function workTime(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function fileRow(f, withRepo) {
  const shown = withRepo && f.repo ? `${f.repo}/${f.rel}` : f.rel;
  const cut = shown.lastIndexOf("/");
  // Como el Quick Open de VS Code: el nombre delante y la carpeta detrás, que es lo que se recorta.
  return `<li title="${esc(shown)}"><span class="sv-path"><b>${esc(shown.slice(cut + 1))}</b><span class="muted">${esc(shown.slice(0, Math.max(cut, 0)))}</span></span>`
    + `<span class="checks-success">+${f.added}</span><span class="checks-failure">−${f.removed}</span></li>`;
}

// Lo destacado de la conversación: el recap del CLI (si lo hay), lo último de Claude, métricas, tus
// peticiones y los ficheros con su diff. Todo sale del transcript (src/sessions.js), sin IA.
function sessionView(s) {
  const added = s.files.reduce((n, f) => n + f.added, 0);
  const removed = s.files.reduce((n, f) => n + f.removed, 0);
  // Los valores van sin escapar: son números o HTML hecho con números.
  const stats = [
    [s.prompts.length, t("peticiones")],
    [s.files.length, t("ficheros")],
    s.files.length && [`<span class="checks-success">+${added}</span> <span class="checks-failure">−${removed}</span>`, t("líneas")],
    s.workMs && [workTime(s.workMs), t("de trabajo")],
    typeof s.costUSD === "number" && [`$${s.costUSD.toFixed(2)}`, t("coste")],
  ].filter(Boolean);
  const where = [
    HOST_LABEL[s.host] || ORIGIN_LABEL[s.entrypoint],
    s.review && t("review de MR"),
    ...s.repos.map((r) => [r.name, r.branch].filter(Boolean).join(" · ")),
  ].filter(Boolean);
  const summary = s.summary?.text
    ? `<section class="sv-summary"><h3>${t("Resumen de Claude Code")} <span>· ${esc(timeAgo(s.summary.at))}</span></h3><p>${esc(s.summary.text)}</p></section>`
    : "";
  const withRepo = new Set(s.files.map((f) => f.repo)).size > 1;
  const prompts = s.prompts.length
    ? `<ol class="sv-prompts">${s.prompts.map((p) => `<li><time>${esc(clock(p.at))}</time><span>${esc(p.text)}</span></li>`).join("")}</ol>`
    : `<p class="muted">${t("Sin peticiones")}</p>`;
  const files = s.files.length
    ? `<ul class="sv-files">${s.files.map((f) => fileRow(f, withRepo)).join("")}</ul>`
    : `<p class="muted">${t("No ha editado ningún fichero")}</p>`;
  return `
    <div class="detail-inner sv ${s.state}" data-id="${esc(s.sessionId)}">
      <button class="detail-close" data-ss="close-view" title="${esc(t("Cerrar (Esc)"))}">✕</button>
      <div class="detail-title sv-title"><span class="ss-dot"></span>${esc(s.title)}</div>
      <div class="detail-sub"><b class="sv-state">${esc(stateLabel(s))}</b>${where.map((w) => `<span>${esc(w)}</span>`).join("")}<span>${esc(timeAgo(s.updatedAt))}</span></div>
      <div class="sv-actions">${s.live ? goButton(s) : `<button class="ss-go-btn" data-ss="resume">${t("Reanudar")}</button>`}${editorButton(s)}</div>
      ${s.links.length ? `<div class="ss-badges">${s.links.map(linkBadge).join("")}</div>` : ""}
      ${summary}
      ${sessionLine(s)}
      <div class="sv-stats">${stats.map(([value, label]) => `<div class="sv-stat"><b>${value}</b><span>${esc(label)}</span></div>`).join("")}</div>
      <div class="sv-cols">
        <section><h3>${t("Tus peticiones")} · ${s.prompts.length}</h3>${prompts}</section>
        <section><h3>${t("Ficheros editados")} · ${s.files.length}</h3>${files}</section>
      </div>
    </div>`;
}

let sessionViewKey = "";

// Repinta la ficha abierta con el último poll. Sin cambios no se toca: no te quita la selección ni el scroll.
function renderSessionView(force = false) {
  const s = (sessionsUi.data || []).find((x) => x.sessionId === viewingId());
  const key = s ? JSON.stringify(s) : "";
  if (!s || (key === sessionViewKey && !force)) return;
  sessionViewKey = key;
  detailContent.innerHTML = sessionView(s);
}

// Como una MR en Cambios: a lo ancho, y el tablero se encoge a la columna de al lado (CSS). ✕, Esc u otro
// click en la tarjeta vuelven al tablero.
function openSessionView(id) {
  if (viewingId() === id) return void hideDetail();
  state.selected = null;
  state.detailPR = null;
  detailPane.classList.remove("hidden");
  detailPane.classList.add("wide");
  detailPane.scrollTop = 0;
  detailContent.innerHTML = `<div class="sv" data-id="${esc(id)}"></div>`;
  renderSessionView(true);
  renderSessions();
  // Del tablero a la columna cambia todo de sitio: que la tarjeta pulsada siga a la vista.
  sessionsPane.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

/* ---------- "¿Qué quieres hacer?": lanzador de agentes encima del tablero ---------- */

// Cada acción abre una sesión interactiva de claude en Ghostty (src/ipc/sessions.js), que luego sale en el
// tablero como cualquier otra. Solo GitLab: las dos skills hablan con GitLab. En modo columna lo esconde el CSS.
function launcherHtml() {
  if (!isGitlab()) return "";
  const l = sessionsUi.launch;
  const option = (action, title, hint) =>
    `<button class="ss-option${l.action === action ? " selected" : ""}" data-ss="launch-pick" data-action="${action}"><b>${esc(title)}</b><span>${esc(hint)}</span></button>`;
  let form = "";
  if (l.action === "implement") form = implementForm(l);
  else if (l.action) form = linkForm(l);
  return `
    <section class="ss-launch">
      <h2>${esc(t("¿Qué quieres hacer?"))}</h2>
      <div class="ss-options">
        ${option("review", t("Review de MR"), t("Con la skill mr-review-gitlab, un agente por MR"))}
        ${option("implement", t("Implementar tarea"), t("Desde un prompt, siempre en un worktree"))}
        ${option("tests", t("Pruebas y casos de uso"), t("Checklist de puntos a comprobar en la tarea"))}
      </div>
      ${form}
    </section>`;
}

// Una MR del link: las que no se lanzan salen en gris con el motivo (un estado inesperado, tal cual).
function targetRow(x) {
  const reason = x.skip && ({ "no-clone": t("sin clon local"), merged: t("fusionada"), closed: t("cerrada"), locked: t("cerrada") }[x.skip] || x.skip);
  return `<li class="${x.skip ? "missing" : ""}"><b>!${x.iid}</b><span class="ss-ellip">${esc(x.title || x.project)}</span><span class="muted">${esc(reason || x.project)}</span></li>`;
}

// Review y pruebas: link → las MRs que se van a lanzar (con su clon) → "Lanzar N".
function linkForm(l) {
  const ready = (l.targets || []).filter((x) => !x.skip).length;
  let targets = "";
  if (l.targets) targets = `<ul class="ss-targets">${l.targets.map(targetRow).join("") || `<li class="muted">${esc(t("No encuentro MRs para ese link"))}</li>`}</ul>`;
  return `
    <form class="ss-launch-form" data-launch="link">
      <input name="url" value="${esc(l.url)}" required placeholder="${esc(t("Link de una MR, una tarea con su MR o una epic con varias MRs"))}" />
      <button class="mini-btn" ${l.busy ? "disabled" : ""}>${esc(l.busy ? t("Buscando…") : t("Buscar MRs"))}</button>
    </form>
    ${targets}
    ${ready ? `<button class="ss-go-btn" data-ss="launch-go">${esc(t("Lanzar {n} en Ghostty", { n: ready }))}</button>` : ""}`;
}

// Implementar: prompt + carpeta elegida SIEMPRE (el agente trabaja en un worktree de ese repo).
function implementForm(l) {
  const where = l.dir ? `${l.repo} · ${l.dir}` : t("Elige dónde lanzarlo: trabajará en un worktree de ese repo");
  return `
    <form class="ss-launch-form ss-implement" data-launch="implement">
      <textarea name="prompt" rows="4" required placeholder="${esc(t("¿Qué hay que hacer? Claude decidirá si es epic o tarea y te la propondrá antes de crearla."))}">${esc(l.prompt)}</textarea>
      <div class="ss-launch-row">
        <button type="button" class="mini-btn" data-ss="launch-dir">${esc(t("Elegir carpeta…"))}</button>
        <span class="ss-ellip${l.dir ? "" : " muted"}" title="${esc(l.dir || "")}">${esc(where)}</span>
        <button class="ss-go-btn" ${l.dir && !l.busy ? "" : "disabled"}>${esc(t("Lanzar en Ghostty"))}</button>
      </div>
    </form>`;
}

// El foco en un campo congela el repintado (renderSessions): se suelta antes de enseñar el resultado.
async function findLaunchTargets() {
  const l = sessionsUi.launch;
  document.activeElement?.blur();
  l.busy = true;
  renderSessions();
  try {
    l.targets = await window.monstro.sessionsLaunchTargets(l.url, l.action);
  } finally {
    l.busy = false;
    renderSessions();
  }
}

// Lanzado: formulario a cero y el tablero se refresca al rato (el agente tarda en escribir su transcript).
function afterLaunch(message) {
  sessionsUi.launch = { ...LAUNCH_EMPTY };
  toast(message, "ok");
  renderSessions();
  setTimeout(loadSessions, 4000);
}

async function launchFromLink() {
  const { launched } = await window.monstro.sessionsLaunch(sessionsUi.launch.url, sessionsUi.launch.action);
  afterLaunch(t("{n} agentes abiertos en Ghostty", { n: launched }));
}

async function launchImplement() {
  const l = sessionsUi.launch;
  document.activeElement?.blur();
  await window.monstro.sessionsImplement(l.prompt, l.dir);
  afterLaunch(t("Agente abierto en Ghostty"));
}

async function onSessionAction(action, id, el) {
  const session = (sessionsUi.data || []).find((s) => s.sessionId === id);
  switch (action) {
    case "close":
      toggleSessionsPane(false);
      break;
    case "close-view":
      hideDetail();
      break;
    case "focus": {
      const result = await window.monstro.sessionsFocus(id);
      if (result?.match === "none") toast(t("No encuentro su pestaña en Ghostty (¿title fijo en su config?)"), "err");
      break;
    }
    case "open": {
      const result = await window.monstro.sessionsOpenEditor(id, el.dataset.dir);
      if (result && !result.ok) throw new Error(result.error);
      break;
    }
    case "resume":
      await window.monstro.sessionsResume(id);
      toast(t("Reanudando en Ghostty…"), "ok");
      break;
    case "launch-pick": {
      const { action } = el.dataset;
      sessionsUi.launch = { ...sessionsUi.launch, action: sessionsUi.launch.action === action ? null : action, targets: null };
      renderSessions();
      sessionsPane.querySelector(".ss-launch-form [name]")?.focus();
      break;
    }
    case "launch-dir": {
      const picked = await window.monstro.sessionsPickDir();
      if (picked) Object.assign(sessionsUi.launch, { dir: picked.dir, repo: picked.project || picked.name });
      renderSessions();
      break;
    }
    case "launch-go":
      await launchFromLink();
      break;
    case "add":
      if (!sessionsUi.tagOpen.delete(id)) sessionsUi.tagOpen.add(id);
      renderSessions();
      sessionsPane.querySelector(`[data-id="${CSS.escape(id)}"] input`)?.focus();
      break;
    case "more":
      sessionsUi.expanded.add(id);
      renderSessions();
      break;
    case "all-waiting":
      sessionsUi.allWaiting = true;
      renderSessions();
      break;
    case "toggle-idle":
      sessionsUi.idleOpen = !sessionsUi.idleOpen;
      renderSessions();
      break;
    case "toggle-finished":
      sessionsUi.finishedOpen = !sessionsUi.finishedOpen;
      renderSessions();
      break;
    case "link":
      openSessionLink(session?.links.find((l) => l.key === el.dataset.key), session);
      break;
    case "hide":
      await window.monstro.sessionsUntag(id, el.dataset.key);
      await loadSessions();
      break;
  }
}

$("#sessions-btn").addEventListener("click", () => toggleSessionsPane());

// Botones del panel y de la ficha; el resto de una tarjeta (no su formulario) abre su ficha.
async function onSessionsClick(event) {
  const el = event.target.closest("[data-ss]");
  const id = event.target.closest("[data-id]")?.dataset.id;
  try {
    if (el) await onSessionAction(el.dataset.ss, id, el);
    else if (id && sessionsPane.contains(event.target) && !event.target.closest("form")) openSessionView(id);
  } catch (err) {
    toast(ipcMessage(err), "err");
  }
}

sessionsPane.addEventListener("click", onSessionsClick);
detailContent.addEventListener("click", (event) => {
  if (event.target.closest(".sv")) onSessionsClick(event);
});

sessionsPane.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const id = form.closest("[data-id]")?.dataset.id;
  try {
    if (form.dataset.launch === "link") return await findLaunchTargets();
    if (form.dataset.launch === "implement") return await launchImplement();
    await window.monstro.sessionsTag(id, form.url.value);
    sessionsUi.tagOpen.delete(id);
    form.url.blur();
    await loadSessions();
  } catch (err) {
    toast(ipcMessage(err), "err");
  }
});

// Los campos del lanzador se guardan al teclear: el poll repinta el panel y no deben perderse.
sessionsPane.addEventListener("input", (event) => {
  if (!event.target.closest("[data-launch]")) return;
  sessionsUi.launch[event.target.name] = event.target.value;
  if (event.target.name !== "url") return;
  // Link nuevo → la lista de MRs de antes ya no vale ("Lanzar" resolvería el link nuevo).
  sessionsUi.launch.targets = null;
  sessionsPane.querySelectorAll(".ss-targets, [data-ss='launch-go']").forEach((n) => n.remove());
});

sessionsPane.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
  event.stopPropagation(); // que el Escape global no cierre además el detalle
  sessionsUi.tagOpen.delete(event.target.closest("[data-id]")?.dataset.id);
  event.target.blur();
  renderSessions();
});
