"use strict";

/* ============ ficha de una sesión: click en su tarjeta → panel de detalle a lo ancho ============ */
// Cabecera (estado, Abrir / Reanudar / Limpiar), la pregunta que te dejó Claude si te espera, sus MRs, tareas
// y epics con título y estado (sessions:linkDetails) y tres pestañas: Resumen (lo que trae sessions:list),
// Plan y Cambios (sessions:detail, que relee el transcript bajo demanda). Lo pedido por IPC se cachea aquí.
const SV_TABS = ["summary", "plan", "changes"];
const SV_LINKS_TTL_MS = 120000;
const SV_SELFTEST_WAIT_MS = 12000; // por debajo de los 20 s del selftest (main.js)
const LINK_KIND_LABEL = { mr: "MR", pr: "PR", issue: "Issue", epic: "Epic" };
// Estado de la MR/tarea → [clase del chip (prs.css), texto]. El texto se traduce al pintar.
const LINK_STATE = { OPEN: ["chip-open", "Abierta"], MERGED: ["chip-merged", "Fusionada"], CLOSED: ["chip-closed", "Cerrada"] };
const PIPELINE_LABEL = { SUCCESS: ["checks-success", "✓", "Pipeline en verde"], FAILURE: ["checks-failure", "✗", "Pipeline fallida"], PENDING: ["checks-pending", "●", "Pipeline en curso"] };

// Por sesión y tipo: { at, v, data, json, error, pending }. `at` = la versión pedida (updatedAt, links + franja
// de 2 min, texto de la pregunta); `v` sube solo si cambió lo recibido y entra en la clave de repintado.
const svData = { detail: new Map(), links: new Map() };
const svEntry = (kind, id) => svData[kind].get(id) || {};

function svFetch(kind, id, at, load) {
  const entry = svData[kind].get(id) || { v: 0 };
  svData[kind].set(id, entry);
  if (entry.pending || entry.at === at) return entry.pending;
  entry.at = at;
  entry.pending = Promise.resolve()
    .then(load) // si el preload no lo expone, el TypeError acaba aquí como un error más
    .then(
      (data) => {
        const json = JSON.stringify(data);
        if (json !== entry.json || entry.error) Object.assign(entry, { data, json, error: null, v: entry.v + 1 });
      },
      (err) => {
        console.error(`[sessions:${kind}]`, err);
        if (entry.error !== ipcMessage(err)) Object.assign(entry, { error: ipcMessage(err), v: entry.v + 1 });
      },
    )
    .finally(() => {
      entry.pending = null;
      renderSessionView();
    });
  return entry.pending;
}

// Lo que la ficha necesita por IPC: el detalle cada vez que el transcript cambia y los links cada 2 min como
// mucho (main los cachea 5).
function svEnsure(s) {
  const id = s.sessionId;
  svFetch("detail", id, s.updatedAt, () => window.monstro.sessionsDetail(id));
  if (s.links.length) {
    const at = `${s.links.map((l) => l.key).join(" ")}|${Math.floor(Date.now() / SV_LINKS_TTL_MS)}`;
    svFetch("links", id, at, () => window.monstro.sessionsLinkDetails(id));
  }
}

// Selftest: espera a lo pedido (con tope: GitLab puede tardar).
function svPending(id) {
  const pending = Object.values(svData).map((cache) => cache.get(id)?.pending).filter(Boolean);
  return Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, SV_SELFTEST_WAIT_MS))]);
}

function svTab(s) {
  const tab = sessionsUi.viewTab.get(s.sessionId) || "summary";
  return tab === "plan" && !s.hasPlan ? "summary" : tab;
}

function svKey(s) {
  const version = (kind) => {
    const e = svEntry(kind, s.sessionId);
    return `${e.v || 0}${e.pending && !e.data ? "…" : ""}`;
  };
  // lrKey: el panel de "Probar en local" (sessions-local.js) también decide si hay que repintar.
  return `${JSON.stringify(s)}|${svTab(s)}|${version("detail")}|${version("links")}|${lrKey(s.sessionId)}`;
}

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

// Mientras no ha llegado sessions:detail: cargando o, si falló, por qué (la ficha sigue sirviendo sin él).
function svStatus(entry, empty) {
  if (entry.data) return empty ? `<p class="muted">${esc(empty)}</p>` : "";
  if (entry.error) return `<p class="muted">${esc(t("No se pudo leer el detalle de la sesión: {err}", { err: entry.error }))}</p>`;
  return `<p class="muted sv-loading"><span class="ss-spin"></span>${esc(t("Cargando…"))}</p>`;
}

/* ---------- la pregunta que te dejó Claude ---------- */

// Pregunta abierta: su texto. Con opciones (AskUserQuestion): pulsar una la copia y te lleva a la sesión como
// "Abrir"; allí solo queda pegarla.
function questionBlock(s) {
  const q = s.question;
  if (q.kind !== "choice") return `<section class="sv-question"><h3>${esc(t("Claude pregunta"))}</h3><div class="md sv-q-md">${renderMarkdown(q.text)}</div></section>`;
  const head = `<h3>${esc(t("Claude pregunta"))} <span>· ${esc(t("pulsa una respuesta: se copia y te llevo a la sesión"))}</span></h3>`;
  const items = (q.items || []).map((item, qi) => `
    <div class="sv-q-item">
      <p class="sv-q-text">${item.header ? `<span class="sv-q-tag">${esc(item.header)}</span>` : ""}${esc(item.question)}${item.multiSelect ? ` <span class="muted">${esc(t("(puedes elegir varias)"))}</span>` : ""}</p>
      <div class="sv-q-options">${item.options.map((o, oi) => `<button class="sv-q-opt" data-ss="answer" data-q="${qi}" data-o="${oi}"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ""}</button>`).join("")}</div>
    </div>`).join("");
  return `<section class="sv-question">${head}${items}</section>`;
}

// Copia la respuesta y enfoca la sesión con la misma acción que su botón "Abrir" de la cabecera.
async function answerSession(s, text) {
  copyText(text, t("Copiado: pégalo en {app}", { app: APP_LABEL[sessionApp(s)] }));
  const open = detailContent.querySelector(".sv-actions .ss-open-btn");
  if (open) await onSessionAction(open.dataset.ss, s.sessionId, open);
}

/* ---------- MRs, tareas y epics de la sesión ---------- */

function linkCard(l, launch) {
  const [chipClass, chipText] = l.draft && l.state === "OPEN" ? ["chip-draft", "Borrador"] : LINK_STATE[l.state] || [];
  const pipe = PIPELINE_LABEL[l.pipeline];
  const closed = l.state === "MERGED" || l.state === "CLOSED";
  const branches = l.sourceBranch
    ? `<span class="branches"><span class="branch">${esc(l.sourceBranch)}</span><span class="arrow">→</span><span class="branch">${esc(l.targetBranch || "?")}</span></span>`
    : "";
  const button = (action, label, tip) =>
    `<button class="mini-btn" data-ss="launch-links" data-action="${action}" data-key="${esc(l.key)}" title="${esc(closed ? t(chipText) : tip)}"${closed ? " disabled" : ""}>${esc(label)}</button>`;
  const actions = launch && l.kind === "mr"
    ? `<div class="sv-link-actions">${button("review", t("Review"), t("Lanza /mr-review-gitlab sobre esta MR en Ghostty"))}${button("security", t("Seguridad"), t("Lanza /security-review en un worktree de la rama de esta MR"))}</div>`
    : "";
  return `
    <div class="sv-link${closed ? " done" : ""}" data-ss="link" data-key="${esc(l.key)}" title="${esc(l.url || "")}">
      <div class="sv-link-top">
        <span class="ss-badge ss-${l.kind}">${esc(LINK_KIND_LABEL[l.kind] || l.kind)}</span>
        ${chipText ? `<span class="chip ${chipClass}">${esc(t(chipText))}</span>` : ""}
        ${pipe ? `<span class="sv-pipe ${pipe[0]}" title="${esc(t(pipe[2]))}">${pipe[1]} pipeline</span>` : ""}
        <button class="sv-link-x" data-ss="hide" data-key="${esc(l.key)}" title="${esc(t("Quitar"))}">×</button>
      </div>
      <div class="sv-link-title"><b>${l.kind === "mr" ? "!" : "#"}${esc(String(l.iid))}</b> ${esc(l.title || "")}</div>
      <div class="sv-link-meta">${l.author ? `<span>@${esc(l.author)}</span>` : ""}${branches}<span class="sv-link-project">${esc(l.project || "")}</span></div>
      ${actions}
    </div>`;
}

// Siempre a la vista (encima de las pestañas). Review / seguridad solo en GitLab: las skills hablan con GitLab.
function linksBlock(s) {
  if (!s.links.length) return "";
  const details = new Map((svEntry("links", s.sessionId).data || []).map((d) => [d.key, d]));
  const launch = isGitlab();
  const all = launch && s.links.filter((l) => l.kind === "mr").length >= 2
    ? `<button class="mini-btn" data-ss="launch-links" data-action="review">${esc(t("Review de todas"))}</button>`
      + `<button class="mini-btn" data-ss="launch-links" data-action="security">${esc(t("Seguridad de todas"))}</button>`
    : "";
  const cards = s.links.map((l) => linkCard({ ...l, ...details.get(l.key), manual: l.manual }, launch)).join("");
  return `<section class="sv-links"><div class="sv-links-head"><h3>${esc(t("Vinculado"))} · ${s.links.length}</h3>${all}</div><div class="sv-link-grid">${cards}</div></section>`;
}

function launchSummary(s, n, skipped) {
  const label = (key) => {
    const l = s.links.find((x) => x.key === key);
    return l ? LINK_LABEL[l.kind].replace("{n}", l.iid) : key;
  };
  const opened = n === 1 ? t("Agente abierto en Ghostty") : n > 1 && t("{n} agentes abiertos en Ghostty", { n });
  const kept = skipped.length && t("No se ha lanzado: {list}", { list: skipped.map((x) => `${label(x.key)} (${skipReason(x.reason)})`).join(", ") });
  return [opened, kept].filter(Boolean).join(" · ") || t("No hay MRs que lanzar");
}

// Review / seguridad de una MR (data-key) o de todas las de la sesión (sin data-key → keys null).
async function launchOnSessionLinks(s, el) {
  el.disabled = true;
  try {
    const result = await window.monstro.sessionsLaunchOnLinks(s.sessionId, el.dataset.action, el.dataset.key ? [el.dataset.key] : null);
    const n = Number(result?.launched) || 0;
    const skipped = result?.skipped || [];
    toast(launchSummary(s, n, skipped), n ? (skipped.length ? "warn" : "ok") : "err");
    if (n) setTimeout(loadSessions, 4000); // el agente tarda en escribir su transcript
  } finally {
    el.disabled = false;
  }
}

/* ---------- pestañas ---------- */

function tabsHtml(s, tab) {
  const detail = svEntry("detail", s.sessionId).data;
  const files = detail ? detail.changes.length : s.files.length;
  const commits = detail?.commits.length ? ` · ${t("{n} commits", { n: detail.commits.length })}` : "";
  const button = (key, label, count = "") =>
    `<button class="tab${tab === key ? " active" : ""}" data-ss="view-tab" data-tab="${key}">${esc(label)}${count ? ` <span class="count">${esc(count)}</span>` : ""}</button>`;
  return `<div class="tabs sv-tabs">${button("summary", t("Resumen"))}${s.hasPlan ? button("plan", t("Plan")) : ""}${button("changes", t("Cambios"), `${t("{n} ficheros", { n: files })}${commits}`)}</div>`;
}

// Lo de siempre: recap del CLI, la pregunta (si no va arriba), lo último de Claude, métricas, tus peticiones
// y los ficheros. Todo sale del transcript vía sessions:list, sin IA.
function summaryTab(s, withQuestion) {
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
    ${summary}
    ${withQuestion && s.question ? questionBlock(s) : ""}
    ${s.question ? "" : sessionLine(s)}
    <div class="sv-stats">${stats.map(([value, label]) => `<div class="sv-stat"><b>${value}</b><span>${esc(label)}</span></div>`).join("")}</div>
    <div class="sv-cols">
      <section><h3>${t("Tus peticiones")} · ${s.prompts.length}</h3>${prompts}</section>
      <section><h3>${t("Ficheros editados")} · ${s.files.length}</h3>${files}</section>
    </div>`;
}

function planTab(s) {
  const entry = svEntry("detail", s.sessionId);
  return entry.data?.plan ? `<article class="md sv-plan">${renderMarkdown(entry.data.plan)}</article>` : svStatus(entry, t("No hay plan en esta sesión"));
}

// Mismo marcado y tema que el diff de una MR (prs.css), sin comentarios: parsePatch (detail.js) sobre el hunk.
function hunkRows(rel, hunk) {
  const family = window.monstroHL?.familyFromFilename(rel);
  const patch = [`@@ -${hunk.oldStart} +${hunk.newStart} @@`, ...(hunk.lines || [])].join("\n");
  return parsePatch(patch).map((line) => {
    if (line.type === "hunk" || line.type === "meta") return `<tr class="diff-${line.type}"><td colspan="3">${esc(line.text)}</td></tr>`;
    const cls = { add: "diff-add", del: "diff-del" }[line.type] || "diff-ctx";
    const sign = { add: "+", del: "−" }[line.type] || " ";
    const code = family ? window.monstroHL.highlightLine(line.text, family) : esc(line.text);
    return `<tr class="diff-line ${cls}"><td class="gutter">${line.old ?? ""}</td><td class="gutter">${line.new ?? ""}</td><td class="code"><span class="sign">${sign}</span>${code}</td></tr>`;
  }).join("");
}

function fileDiff(f, open) {
  const key = `${f.repo || ""}/${f.rel}`;
  const rows = f.hunks?.length
    ? `<table class="diff-table">${f.hunks.map((h) => hunkRows(f.rel, h)).join("")}</table>`
    : `<p class="muted sv-nodiff">${esc(t("Sin diff"))}</p>`;
  const cut = f.truncated ? `<span class="sv-trunc" title="${esc(t("El diff es muy grande: solo se enseña una parte"))}">${esc(t("recortado"))}</span>` : "";
  return `
    <details class="diff-file sv-diff" data-key="${esc(key)}"${open.has(key) ? " open" : ""}>
      <summary><span class="diff-path" title="${esc(f.rel)}">${esc(f.rel.slice(f.rel.lastIndexOf("/") + 1))}</span>${cut}<span class="muted"><span class="checks-success">+${f.added}</span> / <span class="checks-failure">−${f.removed}</span></span></summary>
      ${rows}
    </details>`;
}

// Ficheros por repo y, dentro, por carpeta; cada uno despliega su diff (lo desplegado sobrevive al poll).
function filesByRepo(s, changes) {
  const open = sessionsUi.viewOpen.get(s.sessionId) || new Set();
  const groups = new Map();
  for (const f of changes) {
    const repo = f.repo || t("Fuera de un repo");
    const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    if (!groups.has(repo)) groups.set(repo, new Map());
    const dirs = groups.get(repo);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  const lines = (list) => `<span class="checks-success">+${list.reduce((n, f) => n + f.added, 0)}</span> <span class="checks-failure">−${list.reduce((n, f) => n + f.removed, 0)}</span>`;
  const repos = [...groups].map(([repo, dirs]) => {
    const all = [...dirs.values()].flat();
    const body = [...dirs].map(([dir, files]) => `${dir ? `<div class="sv-dir">${esc(dir)}/</div>` : ""}${files.map((f) => fileDiff(f, open)).join("")}`).join("");
    return `<div class="sv-repo"><h4>${esc(repo)} <span class="muted">${esc(t("{n} ficheros", { n: all.length }))}</span> ${lines(all)}</h4>${body}</div>`;
  }).join("");
  return `<section><h3>${t("Ficheros")} · ${changes.length} <span>${lines(changes)}</span></h3>${repos}</section>`;
}

// Qué cambió: lo último que contó Claude, sus commits y los ficheros con su diff.
function changesTab(s) {
  const entry = svEntry("detail", s.sessionId);
  if (!entry.data) {
    // Sin el detalle (cargando o sin backend) queda al menos la lista de ficheros del poll.
    const withRepo = new Set(s.files.map((f) => f.repo)).size > 1;
    return svStatus(entry, "") + (s.files.length ? `<ul class="sv-files">${s.files.map((f) => fileRow(f, withRepo)).join("")}</ul>` : "");
  }
  const { finalMessage, commits = [], changes = [] } = entry.data;
  if (!finalMessage && !commits.length && !changes.length) return `<p class="muted">${esc(t("Sin cambios registrados"))}</p>`;
  const final = finalMessage
    ? `<section class="sv-final"><h3>${esc(t("Último mensaje de Claude"))}</h3><div class="md">${renderMarkdown(finalMessage)}</div></section>`
    : "";
  const commitRows = commits.map((c) => `<li><code>${esc(String(c.hash || "").slice(0, 8))}</code><span class="sv-commit-subject">${esc(c.subject)}</span>${c.repo ? `<span class="muted">${esc(c.repo)}</span>` : ""}</li>`).join("");
  const commitList = commits.length ? `<section><h3>${t("Commits")} · ${commits.length}</h3><ul class="sv-commits">${commitRows}</ul></section>` : "";
  return `${final}${commitList}${changes.length ? filesByRepo(s, changes) : ""}`;
}

/* ---------- la ficha ---------- */

function sessionView(s) {
  const tab = svTab(s);
  // Si te espera con una pregunta, va arriba del todo; si no, dentro de Resumen.
  const questionOnTop = s.state === "waiting" && Boolean(s.question);
  const where = [
    HOST_LABEL[s.host] || ORIGIN_LABEL[s.entrypoint],
    s.review && t("review de MR"),
    ...s.repos.map((r) => [r.name, r.branch].filter(Boolean).join(" · ")),
  ].filter(Boolean);
  const body = tab === "plan" ? planTab(s) : tab === "changes" ? changesTab(s) : summaryTab(s, !questionOnTop);
  return `
    <div class="detail-inner sv ${s.state}" data-id="${esc(s.sessionId)}">
      <button class="detail-close" data-ss="close-view" title="${esc(t("Cerrar (Esc)"))}">✕</button>
      <div class="detail-title sv-title"><span class="ss-dot"></span>${esc(s.title)}</div>
      <div class="detail-sub"><b class="sv-state">${esc(stateLabel(s))}</b>${where.map((w) => `<span>${esc(w)}</span>`).join("")}<span>${esc(timeAgo(s.updatedAt))}</span>${closeButton(s)}</div>
      <div class="sv-actions">${openButton(s)}${s.live ? "" : `<button class="ss-go-btn" data-ss="resume">${t("Reanudar")}</button>${cleanButton(s)}`}</div>
      ${questionOnTop ? questionBlock(s) : ""}
      ${linksBlock(s)}
      ${localRunBlock(s)}
      ${tabsHtml(s, tab)}
      <div class="sv-tab-body">${body}</div>
    </div>`;
}

let sessionViewKey = "";

// Qué diffs tenías desplegados en la ficha que se va a repintar (el evento toggle llegaría tarde para esto).
function svRememberOpen() {
  const sv = detailContent.querySelector(".sv[data-id]");
  if (!sv) return;
  const open = sessionsUi.viewOpen.get(sv.dataset.id) || new Set();
  sv.querySelectorAll("details[data-key]").forEach((d) => (d.open ? open.add(d.dataset.key) : open.delete(d.dataset.key)));
  sessionsUi.viewOpen.set(sv.dataset.id, open);
}

// Repinta la ficha abierta con el último poll o con lo que llega por IPC. Sin cambios no se toca, y con texto
// seleccionado dentro espera al siguiente poll: no te quita la selección, el scroll ni los diffs desplegados.
function renderSessionView(force = false) {
  const s = (sessionsUi.data || []).find((x) => x.sessionId === viewingId());
  if (!s) return;
  svEnsure(s);
  const key = svKey(s);
  if (key === sessionViewKey && !force) return;
  const selection = document.getSelection();
  if (!force && selection && !selection.isCollapsed && detailContent.contains(selection.anchorNode)) return;
  sessionViewKey = key;
  svRememberOpen();
  const top = detailPane.scrollTop;
  detailContent.innerHTML = sessionView(s);
  detailPane.scrollTop = top;
}

// Como una MR en Cambios: a lo ancho, y el tablero se encoge a la columna de al lado (CSS). ✕, Esc u otro
// click en la tarjeta vuelven al tablero.
function openSessionView(id) {
  if (viewingId() === id) return void hideDetail();
  lrStopPoll(); // el panel de "Probar en local" de la ficha que se va (el tick también se para solo)
  svRememberOpen();
  // Lo que falló (red, IA sin responder) se reintenta al volver a abrir la ficha.
  for (const cache of Object.values(svData)) {
    if (cache.get(id)?.error) cache.get(id).at = null;
  }
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

function switchSessionTab(s, tab) {
  if (!SV_TABS.includes(tab)) return;
  sessionsUi.viewTab.set(s.sessionId, tab);
  renderSessionView(true);
  // Si venías de muy abajo, que la pestaña nueva empiece a la vista, justo bajo sus pestañas.
  const tabs = detailContent.querySelector(".sv-tabs");
  const y = tabs ? tabs.getBoundingClientRect().top - detailPane.getBoundingClientRect().top : 0;
  if (y < 0) detailPane.scrollTop += y - 12;
}

// Botones propios de la ficha: onSessionAction (sessions.js) le pasa los que no son suyos.
async function onSessionViewAction(action, s, el) {
  if (!s) return;
  switch (action) {
    case "view-tab":
      switchSessionTab(s, el.dataset.tab);
      break;
    case "answer": {
      const option = s.question?.items?.[Number(el.dataset.q)]?.options?.[Number(el.dataset.o)];
      if (option) await answerSession(s, option.label);
      break;
    }
    case "launch-links":
      await launchOnSessionLinks(s, el);
      break;
    default:
      await onLocalRunAction(action, s, el); // panel "Probar en local" (sessions-local.js)
  }
}

// Enlaces del markdown (plan, último mensaje, pregunta): al navegador, nunca dentro de la ventana.
detailContent.addEventListener("click", (event) => {
  const a = event.target.closest(".sv a[href]");
  if (!a) return;
  event.preventDefault();
  if (a.href.startsWith("https://")) window.monstro.openExternal(a.href);
});

// Selftest `sessions-view[:<texto>][#summary|plan|changes|local]`: la ficha de la primera sesión que case con
// el texto (el mismo filtro del tablero; sin texto, la de más peticiones) en esa pestaña, ya con lo pedido por
// IPC. `#local` no es una pestaña: abre el panel de "Probar en local" con su plan cargado (no levanta nada).
async function runSessionsViewSelftest(spec = "") {
  state.selftestNotified = true;
  try {
    const [text = "", tab] = spec.replace(/^:/, "").split("#");
    toggleSessionsPane(true);
    await loadSessions();
    const all = sessionsUi.data || [];
    const words = foldText(text).split(/\s+/).filter(Boolean);
    const session = words.length ? all.find((s) => sessionMatches(s, words)) : [...all].sort((a, b) => b.prompts.length - a.prompts.length)[0];
    if (session) {
      if (tab && tab !== "local") sessionsUi.viewTab.set(session.sessionId, tab);
      openSessionView(session.sessionId);
      await svPending(session.sessionId);
      if (tab === "local") await lrSelftestOpen(session);
      // En Cambios, el primer diff desplegado y a la vista (la cabecera ya sale en las demás capturas).
      const diff = tab === "changes" && detailContent.querySelector(".sv-diff");
      if (diff) {
        diff.open = true;
        detailPane.scrollTop += (diff.closest(".sv-repo") || diff).getBoundingClientRect().top - detailPane.getBoundingClientRect().top - 12;
      }
    }
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}
