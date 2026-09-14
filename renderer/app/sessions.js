"use strict";

/* ============ panel de sesiones de Claude Code (src/sessions.js), a la izquierda ============ */
// Diseño "Actividad": primero las que te esperan (con lo último que dijo o pidió Claude), luego las que
// trabajan (con la herramienta en curso) y las terminadas de hoy. Click en una tarjeta → su ficha grande
// (resumen, tus peticiones, ficheros y métricas) en el panel de detalle.
// Poll cada 10 s con el panel abierto; cerrado o con la ventana oculta, cada 30 s: de ahí salen el contador,
// el badge del dock y los avisos de macOS.
const SESSIONS_TICK_MS = 10000;
const SESSIONS_IDLE_TICKS = 3;
const SESSIONS_MAX_LINKS = 6;
const SESSIONS_MAX_WAITING = 4;
const LINK_LABEL = { mr: "!{n}", pr: "PR #{n}", issue: "#{n}", epic: "Epic #{n}" };
const ORIGIN_LABEL = { "claude-vscode": "VS Code", cli: "CLI" };
const HOST_LABEL = { ghostty: "Ghostty", rider: "Rider", vscode: "VS Code · terminal", "vscode-ext": "VS Code", terminal: "Terminal", iterm: "iTerm" };
// Host → app a la que lleva "Abrir" (clave de sessions:appIcons); extensión y terminal de VS Code son la misma.
const HOST_APP_KEY = { ghostty: "ghostty", rider: "rider", vscode: "vscode", "vscode-ext": "vscode", terminal: "terminal", iterm: "iterm" };
const APP_LABEL = { ghostty: "Ghostty", rider: "Rider", vscode: "VS Code", terminal: "Terminal", iterm: "iTerm" };
const sessionsPane = $("#sessions-pane");
// Estado del lanzador ("¿Qué quieres hacer?"): vive aquí para sobrevivir a los repintados del poll.
const LAUNCH_EMPTY = { action: null, url: "", prompt: "", dir: null, repo: null, clones: null, root: null, targets: null, busy: false };
// viewTab / viewOpen: pestaña activa y diffs desplegados de cada ficha (sessions-view.js), en memoria.
// localRun: el panel "Probar en local" de cada ficha (sessions-local.js), también en memoria.
const sessionsUi = { data: null, pending: null, tagOpen: new Set(), expanded: new Set(), allWaiting: false, idleOpen: true, finishedOpen: true, ticks: 0, filter: "", launch: { ...LAUNCH_EMPTY }, viewTab: new Map(), viewOpen: new Map(), localRun: new Map() };

const sessionsOpen = () => !sessionsPane.classList.contains("hidden");
// Electron envuelve los throw del main: "Error invoking remote method 'x': Error: <mensaje>".
const ipcMessage = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
// Sesión cuya ficha enseña el panel de detalle, o null. Se lee del DOM: si una MR u otra vista pisa el
// panel, la ficha deja de estar y el poll ya no la repinta.
const viewingId = () => (detailPane.classList.contains("hidden") ? null : detailContent.querySelector(".sv")?.dataset.id || null);
const selectedClass = (s) => (s.sessionId === viewingId() ? " selected" : "");

function toggleSessionsPane(open = !sessionsOpen()) {
  sessionsPane.classList.toggle("hidden", !open);
  // "open" y no "active": las vistas limpian .active de todos los .bucket al navegar.
  $("#sessions-btn").classList.toggle("open", open);
  if (open) {
    if (!detailPane.classList.contains("hidden")) hideDetail(); // el tablero va a pantalla completa
    loadSessions();
  } else if (viewingId()) {
    hideDetail(); // sin panel no hay ficha
  }
}

function loadSessions() {
  sessionsUi.pending ??= window.monstro.sessionsList()
    .then((data) => {
      notifySessionChanges(sessionsUi.data, data);
      sessionsUi.data = data;
    })
    .catch((err) => console.error("[sessions]", err))
    .finally(() => {
      sessionsUi.pending = null;
      renderSessions();
      renderSessionView();
    });
  return sessionsUi.pending;
}

// Lo que te pregunta una sesión que te espera: la pregunta (con opciones o abierta), el permiso o su último párrafo.
function questionText(s) {
  if (s.question?.kind === "choice") return s.question.items[0]?.question || "";
  return s.question?.text || (s.waitingFor ? t("Necesita tu respuesta") : s.excerpt || "");
}

// Aviso de macOS cuando una sesión pasa a esperarte o acaba su turno y queda lista para más trabajo. Como las
// PRs (poll.js): el primer poll no avisa, solo los cambios. Click en el aviso → su ficha (onNotifySession).
function notifySessionChanges(before, after) {
  if (!before || IS_SELFTEST) return;
  const was = new Map(before.map((s) => [s.sessionId, s.state]));
  for (const s of after) {
    const prev = was.get(s.sessionId);
    if (s.state === "waiting" && prev !== "waiting") {
      window.monstro.notify(t("Claude te espera · {title}", { title: s.title }), questionText(s), s.sessionId);
    } else if (s.state === "done" && prev === "working") {
      window.monstro.notify(t("Claude ha terminado · {title}", { title: s.title }), s.excerpt || t("Listo para seguir con más trabajo"), s.sessionId);
    }
  }
}

// La app arranca siempre en el tablero de Agents. El selftest no: sus rutas parten de la lista.
function initSessions() {
  const open = !IS_SELFTEST;
  toggleSessionsPane(open);
  if (!open) loadSessions();
  setInterval(() => {
    // Cerrado u oculto va más despacio, pero no para: sin poll no habría avisos justo cuando no miras.
    if ((document.hidden || !sessionsOpen()) && ++sessionsUi.ticks % SESSIONS_IDLE_TICKS) return;
    loadSessions();
  }, SESSIONS_TICK_MS);
}

// Selftest `sessions` y `sessions-q:<texto>` (el tablero ya filtrado).
async function runSessionsSelftest(filter = "") {
  state.selftestNotified = true;
  sessionsUi.filter = filter;
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

// Selftest `sessions-implement`: el formulario de "Implementar tarea" con "Todos los repos" elegido en el desplegable.
async function runSessionsImplementSelftest() {
  state.selftestNotified = true;
  try {
    toggleSessionsPane(true);
    await loadSessions();
    await pickLaunchAction("implement");
    const select = sessionsPane.querySelector('[name="clone"]');
    if (select && sessionsUi.launch.root) {
      select.value = sessionsUi.launch.root;
      pickClone(select);
    }
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

// Iconos reales de las apps (sessions:appIcons, dataURL): se piden la primera vez que hacen falta y se
// repinta al llegar. Hasta entonces, o si la app no está en este Mac, el botón va solo con el texto.
let sessionsIcons = null;

function sessionsAppIcon(app) {
  if (!sessionsIcons) {
    sessionsIcons = {};
    window.monstro.sessionsAppIcons()
      .then((icons) => {
        sessionsIcons = icons || {};
        renderSessions();
        renderSessionView(true);
      })
      .catch((err) => console.error("[sessions]", err));
  }
  return sessionsIcons[app] || "";
}

// App a la que lleva "Abrir" (clave de APP_LABEL / sessions:appIcons).
const sessionApp = (s) => (s.live ? HOST_APP_KEY[s.host] : null) || (s.stack === "dotnet" ? "rider" : "vscode");

// Un solo botón "Abrir" con el icono de la app: viva y con host conocido → trae esa app al frente (focus);
// si no, abre su carpeta en el editor de su stack, como agents.openEditor (.NET → Rider, el resto → VS Code).
function openButton(s) {
  const host = s.live ? HOST_APP_KEY[s.host] : null;
  const app = sessionApp(s);
  const action = host ? `data-ss="focus"` : `data-ss="open" data-dir="${esc(s.dir || "")}"`;
  const icon = sessionsAppIcon(app);
  return `<button class="ss-open-btn" ${action} title="${esc(t("Abrir en {app}", { app: APP_LABEL[app] }))}">`
    + `${icon ? `<img src="${esc(icon)}" alt="" />` : ""}${esc(t("Abrir"))}</button>`;
}

// Lo que se enseña bajo el título: si te espera, qué te pide o qué dijo; si trabaja, qué está haciendo.
function sessionLine(s) {
  if (s.state === "working") {
    return `<div class="ss-activity"><span class="ss-spin"></span><span class="ss-ellip">${esc(s.activity || t("Pensando…"))}</span></div>`;
  }
  // Una pregunta con opciones (AskUserQuestion) se enseña tal cual, no el párrafo genérico.
  const choice = s.state === "waiting" && s.question?.kind === "choice" ? questionText(s) : "";
  const quote = choice || (s.waitingFor ? `${t("Necesita tu respuesta")}${s.activity ? `: ${s.activity}` : ""}` : s.excerpt || s.activity);
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
        ${openButton(s)}
        <button class="mini-btn" data-ss="add" title="${esc(t("Asociar MR, issue o epic"))}">+</button>
        ${closeButton(s)}
      </div>
      ${tagForm}
    </div>`;
}

// Viva: para su proceso (la extensión de VS Code deja vivos los de pestañas cerradas) y la saca del panel.
// Terminada: solo la saca. Trabajando no se ofrece: se cortaría a medias.
function closeButton(s) {
  if (s.state === "working") return "";
  const [label, tip] = s.live ? [t("Cerrar"), t("Cerrar la sesión y quitarla del panel")] : [t("Quitar"), t("Quitar del panel")];
  return `<button class="mini-btn" data-ss="close-session" title="${esc(tip)}">${esc(label)}</button>`;
}

// Terminada = nadie trabaja ya en sus worktrees de agente: es el momento de quitarlos (sus ramas se quedan).
function cleanButton(s) {
  const n = s.worktrees?.length || 0;
  return n ? `<button class="mini-btn ss-clean" data-ss="clean-wt" title="${esc(s.worktrees.join("\n"))}">${esc(t("Limpiar worktrees ({n})", { n }))}</button>` : "";
}

// Resultado por worktree (git puede negarse con uno y seguir con los demás): cuántos se quitaron y cuáles no, y por qué.
function cleanSummary(results) {
  const why = { dirty: t("cambios sin commitear"), busy: t("en uso por una sesión viva") };
  const label = (dir) => dir.replace(/[\\/]\.(claude[\\/])?worktrees[\\/]/, "/").split("/").slice(-2).join("/");
  const kept = results.filter((r) => !r.ok).map((r) => `${label(r.dir)} (${why[r.reason] || r.reason})`);
  const removed = results.length - kept.length;
  return [removed && t("{n} worktrees quitados", { n: removed }), kept.length && t("No se han quitado: {list}", { list: kept.join(", ") })]
    .filter(Boolean).join(" · ") || t("Nada que limpiar");
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
        ${closeButton(s)}
        ${cleanButton(s)}
      </div>
      ${links.length ? `<div class="ss-badges ss-done-links">${links.map(linkBadge).join("")}</div>` : ""}
    </div>`;
}

function sectionHead(kind, label, count, toggle = "", open = true) {
  const chevron = toggle ? `<span class="ss-chevron">${open ? "▾" : "▸"}</span>` : "";
  const tag = toggle ? "button" : "div";
  return `<${tag} class="ss-sec ss-sec-${kind}" ${toggle ? `data-ss="${toggle}"` : ""}>${chevron}<span class="ss-dot"></span>${esc(label)} · ${count}</${tag}>`;
}

// Filtro del tablero: cada palabra tiene que salir en la sesión (título, lo último que dijo, tus peticiones,
// repos y ramas o sus badges: "mr", "!123", "epic", el proyecto o la URL). Sin tildes ni mayúsculas.
const foldText = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function sessionMatches(s, words) {
  const hay = foldText([
    s.title, s.excerpt, s.activity, s.summary?.text,
    ...s.prompts.map((p) => p.text),
    ...s.repos.flatMap((r) => [r.project, r.name, r.branch]),
    ...s.links.flatMap((l) => [l.kind, LINK_LABEL[l.kind].replace("{n}", l.iid), l.project, l.url]),
  ].filter(Boolean).join("\n"));
  // Una URL copiada del navegador puede llevar /diffs detrás: vale si empieza por la de un badge.
  return words.every((w) => hay.includes(w) || s.links.some((l) => l.url && w.startsWith(foldText(l.url))));
}

// `force`: repintar aunque haya un campo del panel con el foco (el filtro, mientras se teclea).
function renderSessions(force = false) {
  const all = sessionsUi.data || [];
  // El contador del botón es lo que pide atención: las que te esperan (sin filtrar).
  const waitingCount = all.filter((s) => s.state === "waiting").length;
  $("#sessions-count").textContent = waitingCount ? String(waitingCount) : "";
  setDockBadge("agents", waitingCount);
  if (!sessionsOpen()) return;
  // No repintar mientras se escribe una URL: el poll se llevaría el input por delante.
  if (!force && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && sessionsPane.contains(document.activeElement)) return;

  const words = foldText(sessionsUi.filter).split(/\s+/).filter(Boolean);
  const shown = words.length ? all.filter((s) => sessionMatches(s, words)) : all;
  const waiting = shown.filter((s) => s.state === "waiting");
  const working = shown.filter((s) => s.state === "working");
  // Abiertas sin nada pendiente (terminal/IDE aún abierto) ≠ terminadas (proceso cerrado).
  const idle = shown.filter((s) => s.state === "done");
  const finished = shown.filter((s) => s.state === "finished");
  const filter = all.length
    ? `<input class="ss-filter" type="search" value="${esc(sessionsUi.filter)}" placeholder="${esc(t("Filtrar por palabra, proyecto, epic, issue o MR"))}" />`
    : "";

  let body = `<div class="ss-empty">${t("Cargando…")}</div>`;
  if (sessionsUi.data && !all.length) body = `<div class="ss-empty">${t("No hay sesiones en las últimas 24 h")}</div>`;
  else if (all.length && !shown.length) body = `<div class="ss-empty">${t("Ninguna sesión coincide con el filtro")}</div>`;
  if (shown.length) {
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
    ${filter}
    ${body}`;
}

// El foco en el filtro congela el repintado del poll: se repinta a mano al teclear y se le devuelve el foco.
function filterSessions(input) {
  const caret = input.selectionStart;
  sessionsUi.filter = input.value;
  renderSessions(true);
  const fresh = sessionsPane.querySelector(".ss-filter");
  fresh?.focus();
  fresh?.setSelectionRange(caret, caret);
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

/* La ficha de una sesión (click en su tarjeta) vive en sessions-view.js. */

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

// Por qué no se lanza una MR (lanzador y botones de la ficha); un motivo desconocido va tal cual.
const skipReason = (code) => ({ "no-clone": t("sin clon local"), "no-branch": t("sin rama"), merged: t("fusionada"), closed: t("cerrada"), locked: t("cerrada") })[code] || code;

// Una MR del link: las que no se lanzan salen en gris con el motivo (un estado inesperado, tal cual).
function targetRow(x) {
  const reason = x.skip && skipReason(x.skip);
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
  // Uno de tus clones (carpeta raíz de Trabajo local) o, con el diálogo, cualquier otra carpeta.
  const clones = l.clones?.length
    ? `<select name="clone"><option value="">${esc(t("Elige uno de tus repos…"))}</option>`
      + (l.root ? `<option value="${esc(l.root)}"${l.root === l.dir ? " selected" : ""}>${esc(t("Todos los repos (el agente elige)"))}</option>` : "")
      + `${l.clones.map((c) => `<option value="${esc(c.dir)}"${c.dir === l.dir ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`
    : "";
  return `
    <form class="ss-launch-form ss-implement" data-launch="implement">
      <textarea name="prompt" rows="4" required placeholder="${esc(t("¿Qué hay que hacer? Claude decidirá si es epic o tarea y te la propondrá antes de crearla."))}">${esc(l.prompt)}</textarea>
      <div class="ss-launch-row">
        ${clones}
        <button type="button" class="mini-btn" data-ss="launch-dir">${esc(t("Elegir carpeta…"))}</button>
        <span class="ss-ellip${l.dir ? "" : " muted"}" title="${esc(l.dir || "")}">${esc(where)}</span>
        <button class="ss-go-btn" ${l.dir && !l.busy ? "" : "disabled"}>${esc(t("Lanzar en Ghostty"))}</button>
      </div>
    </form>`;
}

// Abre (o cierra, si ya estaba abierto) el formulario de una acción. Implementar trae antes tus clones
// (local:repos, ~200 ms): después el foco del textarea congelaría el repintado que los enseña.
async function pickLaunchAction(action) {
  const next = sessionsUi.launch.action === action ? null : action;
  const found = next === "implement" ? await window.monstro.localRepos().catch(() => null) : null;
  sessionsUi.launch = { ...sessionsUi.launch, action: next, clones: found?.repos || null, root: found?.rootDir || null, targets: null };
  renderSessions();
  sessionsPane.querySelector(".ss-launch-form [name]")?.focus();
}

// Un clon del desplegable vale como una carpeta del diálogo (main lo vuelve a comprobar al lanzar).
function pickClone(select) {
  const l = sessionsUi.launch;
  const clone = select.value === l.root ? { dir: l.root, name: t("todos los repos") } : l.clones?.find((c) => c.dir === select.value);
  Object.assign(l, { dir: clone?.dir || null, repo: clone ? clone.gitlabPath || clone.name : null });
  document.activeElement?.blur(); // con el foco en un campo no se repinta, y "Lanzar" tiene que activarse
  renderSessions();
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
    case "clean-wt": {
      if (!session?.worktrees?.length) break;
      const ask = t("¿Quito estos worktrees? Sus ramas se quedan, así que no se pierde nada commiteado; si alguno tiene cambios sin commitear, no se toca.");
      if (!confirm(`${ask}\n\n${session.worktrees.join("\n")}`)) break;
      const results = await window.monstro.sessionsCleanWorktrees(id);
      toast(cleanSummary(results), results.every((r) => r.ok) ? "ok" : "err");
      await loadSessions();
      break;
    }
    case "close-session": {
      if (!session) break;
      const ask = session.live
        ? t("¿Cierro esta sesión? Se para su proceso de Claude (si aún la tienes abierta en una pestaña, esa pestaña deja de funcionar) y sale del panel. Podrás reanudarla con claude --resume.")
        : t("¿Quito esta sesión del panel? No se borra nada: podrás reanudarla con claude --resume.");
      if (!confirm(`${ask}\n\n${session.title}`)) break;
      await window.monstro.sessionsClose(id);
      if (viewingId() === id) hideDetail();
      toast(session.live ? t("Sesión cerrada") : t("Sesión quitada del panel"), "ok");
      await loadSessions();
      break;
    }
    case "launch-pick":
      await pickLaunchAction(el.dataset.action);
      break;
    case "launch-dir": {
      const picked = await window.monstro.sessionsPickDir();
      if (picked) Object.assign(sessionsUi.launch, { dir: picked.dir, repo: picked.multi ? t("{name} (varios repos)", { name: picked.name }) : picked.project || picked.name });
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
    default:
      await onSessionViewAction(action, session, el); // botones propios de la ficha (sessions-view.js)
  }
}

$("#sessions-btn").addEventListener("click", () => toggleSessionsPane());

// Click en el aviso de macOS de una sesión → Monstro al frente (lo hace main) con su ficha abierta.
window.monstro.onNotifySession((id) => {
  if (!sessionsOpen()) toggleSessionsPane(true);
  if (viewingId() !== id) openSessionView(id);
});

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
  if (event.target.matches(".ss-filter")) return void filterSessions(event.target);
  if (!event.target.closest("[data-launch]")) return;
  if (event.target.name === "clone") return void pickClone(event.target);
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
