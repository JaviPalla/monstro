"use strict";

/* ============ panel de sesiones de Claude Code (src/sessions.js), a la izquierda ============ */
// Diseño "Actividad": primero las que te esperan (con lo último que dijo o pidió Claude), luego las que
// trabajan (con la herramienta en curso) y las terminadas de hoy. Al abrirlo el menú se pliega a iconos
// para dejar sitio. Abierto/cerrado se recuerda en localStorage (preferencia de este equipo, no config).
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
const sessionsUi = { data: null, pending: null, tagOpen: new Set(), expanded: new Set(), allWaiting: false, idleOpen: true, finishedOpen: true, ticks: 0 };

const sessionsOpen = () => !sessionsPane.classList.contains("hidden");
// Electron envuelve los throw del main: "Error invoking remote method 'x': Error: <mensaje>".
const ipcMessage = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

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
  if (open) loadSessions();
}

function loadSessions() {
  sessionsUi.pending ??= window.monstro.sessionsList()
    .then((data) => { sessionsUi.data = data; })
    .catch((err) => console.error("[sessions]", err))
    .finally(() => {
      sessionsUi.pending = null;
      renderSessions();
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

// Título clicable: viva → te lleva a donde corre (terminal / IDE); terminada → solo el título.
function sessionHeader(s) {
  const top = `<span class="ss-dot"></span><span class="ss-title">${esc(s.title)}</span><span class="ss-time">${esc(timeAgo(s.updatedAt))}</span>`;
  return s.live
    ? `<button class="ss-top ss-go" data-ss="focus" title="${esc(`${t("Ir a la sesión")} · ${s.title}`)}">${top}</button>`
    : `<div class="ss-top" title="${esc(s.title)}">${top}</div>`;
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
  const go = HOST_APP_LABEL[s.host]
    ? `<button class="ss-go-btn" data-ss="focus">${esc(t("Ir a {app}", { app: HOST_APP_LABEL[s.host] }))}</button>`
    : "";
  const tagForm = sessionsUi.tagOpen.has(s.sessionId)
    ? `<form class="ss-tag-form"><input name="url" required placeholder="${esc(t("Pega la URL de una MR, issue o epic"))}" /></form>`
    : "";
  return `
    <div class="ss-card ${s.state}" data-id="${esc(s.sessionId)}">
      ${sessionHeader(s)}
      <div class="ss-meta">${esc(meta)}</div>
      ${sessionLine(s)}
      ${linkBadges(s)}
      <div class="ss-actions">
        ${go}
        <button class="mini-btn" data-ss="open" data-dir="${esc(s.dir || "")}" title="${esc(t("Abrir {p} en {e}", { p: s.dir || "", e: EDITOR_LABEL[s.stack] || "VS Code" }))}">${EDITOR_LABEL[s.stack] || "VS Code"}</button>
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
    <div class="ss-done" data-id="${esc(s.sessionId)}" title="${esc([s.title, s.excerpt].filter(Boolean).join(" · "))}">
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
  if (document.activeElement?.tagName === "INPUT" && sessionsPane.contains(document.activeElement)) return;

  let body = `<div class="ss-empty">${t("Cargando…")}</div>`;
  if (sessionsUi.data && !all.length) body = `<div class="ss-empty">${t("No hay sesiones en las últimas 24 h")}</div>`;
  if (all.length) {
    const shownWaiting = sessionsUi.allWaiting ? waiting : waiting.slice(0, SESSIONS_MAX_WAITING);
    const hiddenWaiting = waiting.length - shownWaiting.length;
    body = [
      waiting.length ? sectionHead("waiting", t("Esperándote"), waiting.length) + shownWaiting.map(sessionCard).join("") : "",
      hiddenWaiting > 0 ? `<button class="ss-more-link" data-ss="all-waiting">${t("Ver {n} más esperando", { n: hiddenWaiting })}</button>` : "",
      working.length ? sectionHead("working", t("Trabajando"), working.length) + working.map(sessionCard).join("") : "",
      idle.length ? sectionHead("idle", t("Sin pendientes"), idle.length, "toggle-idle", sessionsUi.idleOpen) + (sessionsUi.idleOpen ? idle.map(sessionCard).join("") : "") : "",
      finished.length ? sectionHead("finished", t("Terminadas"), finished.length, "toggle-finished", sessionsUi.finishedOpen) + (sessionsUi.finishedOpen ? finished.map(finishedRow).join("") : "") : "",
    ].join("");
  }
  sessionsPane.innerHTML = `
    <div class="ss-head">
      <strong>${t("Sesiones de Claude")}</strong>
      <span class="ss-sub">${t("{n} vivas", { n: all.filter((s) => s.live).length })}</span>
      <button class="icon-btn ss-close" data-ss="close" title="${esc(t("Cerrar el panel"))}">✕</button>
    </div>
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

async function onSessionAction(action, id, el) {
  const session = (sessionsUi.data || []).find((s) => s.sessionId === id);
  switch (action) {
    case "close":
      toggleSessionsPane(false);
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
      toast(t("Reanudando en Terminal…"), "ok");
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

sessionsPane.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-ss]");
  if (!el) return;
  try {
    await onSessionAction(el.dataset.ss, el.closest("[data-id]")?.dataset.id, el);
  } catch (err) {
    toast(ipcMessage(err), "err");
  }
});

sessionsPane.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const id = form.closest("[data-id]")?.dataset.id;
  try {
    await window.monstro.sessionsTag(id, form.url.value);
    sessionsUi.tagOpen.delete(id);
    form.url.blur();
    await loadSessions();
  } catch (err) {
    toast(ipcMessage(err), "err");
  }
});

sessionsPane.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.target.tagName !== "INPUT") return;
  event.stopPropagation(); // que el Escape global no cierre además el detalle
  sessionsUi.tagOpen.delete(event.target.closest("[data-id]")?.dataset.id);
  event.target.blur();
  renderSessions();
});
