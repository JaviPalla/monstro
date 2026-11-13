"use strict";

// Vista de Pruebas (solo GitLab): las tareas que alguien tiene que probar —epics, issues locales, MRs
// sueltas y hotfix— con el pipeline del flujo de delivery-flow. Lo que cuenta es el pipeline `Epic #N`
// (el que el bot enlaza en el comentario de la epic) y, debajo, el de cada MR. El main
// (src/pruebas-rules.js) ya manda cada job con su botón (`action`) y su confirmación (`confirm`) y el
// estado de la tarjeta: aquí solo se pinta y se lanza. Se mantiene al día sola (startPruPoll): cada 10 s
// recarga las tarjetas con algún job en marcha y cada `pollSeconds` la lista entera, en silencio; además
// «Recargar» y la tarjeta afectada tras cada acción.

// código de estado (lo calcula el main) → [texto, tono]
const PRU_STATE = {
  "no-pipeline": ["Sin pipeline", "muted"],
  canceled: ["Cancelado", "muted"],
  "probar-ready": ["Lista para probar", "manual"],
  "probar-failed": ["probar-tarea falló", "err"],
  probando: ["Subiendo a dev", "pending"],
  deploying: ["Desplegando en dev", "pending"],
  "deploy-failed": ["Despliegue fallido", "err"],
  "in-dev": ["En dev · falta validar", "manual"],
  "validar-ready": ["Lista para validar", "manual"],
  validando: ["Validando", "pending"],
  "validar-failed": ["La validación falló", "err"],
  "validate-failed": ["La validación falló", "err"],
  "merge-ready": ["Validada · falta mergear", "ok"],
  "mergear-ready": ["Lista para mergear", "ok"],
  mergeando: ["Mergeando", "pending"],
  "mergear-failed": ["El merge falló", "err"],
  merged: ["Mergeada", "ok"],
  "no-mrs": ["Sin MRs abiertas", "muted"],
  unknown: ["—", "muted"],
};

const PRU_GROUPS = [
  { label: "Epics", of: (x) => x.kind === "epic" },
  { label: "Tareas sin epic", of: (x) => x.kind !== "epic" && !x.hotfix },
  { label: "Hotfix", of: (x) => x.kind === "mr" && x.hotfix },
];

// Etiquetas de GitLab elegidas en la barra de filtro: la tarea debe llevarlas todas. Se recuerdan entre sesiones.
const PRU_LABELS_KEY = "monstro:pruebas-labels";
const pruIsQa = (l) => /^qa\s*:/i.test(l); // «QA: nombre»: quien se lleva la tarea a probar
const pruLabelOrder = (a, b) => pruIsQa(b) - pruIsQa(a) || a.localeCompare(b);

function pruLoadLabels() {
  try {
    const v = JSON.parse(localStorage.getItem(PRU_LABELS_KEY) || "[]");
    return Array.isArray(v) && v.every((l) => typeof l === "string") ? v : [];
  } catch {
    return [];
  }
}

function setPruLabels(labels) {
  state.pruebas.labelFilter = labels;
  try {
    localStorage.setItem(PRU_LABELS_KEY, JSON.stringify(labels));
  } catch {
    /* sin almacenamiento: el filtro vale hasta cerrar la app */
  }
  renderPruebas();
}

function togglePruLabel(label) {
  const cur = state.pruebas.labelFilter;
  setPruLabels(cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]);
}

let pruRun = 0; // id de la carga en curso: los parciales de una carga anterior se descartan
let pruSilentRun = 0; // id de la recarga silenciosa en vuelo (0 = ninguna): el sondeo no lanza otra encima
const pruRefreshing = new Set(); // keys de tarjeta con una recarga del sondeo en curso: el siguiente tick no la repite
const pruOpen = new Set(); // «otros jobs» abiertos por el usuario (projectId!iid): sobreviven a los repintados
const PRU_TICK_MS = 10000;
let pruTimer = null;

async function enterPruebas() {
  if (!isGitlab()) {
    toast(t("La vista de Pruebas solo está disponible en GitLab"), "");
    return;
  }
  state.view = "pruebas";
  state.pruebas.labelFilter = pruLoadLabels();
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-pruebas")?.classList.add("active");
  startPruPoll();
  await loadPruebas();
}

// Cada tick recarga las tarjetas con algún job en marcha; cada `pollSeconds` (60 s), la lista entera (tareas
// nuevas, etiquetas, lo que alguien haya hecho desde GitLab). Se da de baja solo al salir de la vista.
function startPruPoll() {
  clearInterval(pruTimer);
  const fullEvery = Math.max(1, Math.round(((state.config?.pollSeconds || 60) * 1000) / PRU_TICK_MS));
  let ticks = 0;
  pruTimer = setInterval(() => {
    if (state.view !== "pruebas") return clearInterval(pruTimer);
    if (document.hidden || state.pruebas.loading) return;
    if (++ticks % fullEvery === 0) {
      if (pruSilentRun !== pruRun) loadPruebas({ silent: true });
    } else {
      refreshLivePruebas();
    }
  }, PRU_TICK_MS);
}

function refreshLivePruebas() {
  for (const task of state.pruebas.tasks || []) {
    if (!task.detail?.live || pruRefreshing.has(task.key)) continue;
    pruRefreshing.add(task.key);
    refreshPruTask(task, true).finally(() => pruRefreshing.delete(task.key));
  }
}

// `silent` (recarga del sondeo): no repinta si no cambió nada.
function applyPruBoard(board, silent = false) {
  const p = state.pruebas;
  const next = { tasks: board.tasks, errors: board.errors || [], labels: board.labels ?? p.labels };
  if (silent && JSON.stringify(next) === JSON.stringify({ tasks: p.tasks, errors: p.errors, labels: p.labels })) return;
  Object.assign(p, next, { progress: { loaded: board.loaded, total: board.total } });
  renderPruebas();
}

// `silent`: sin «Cargando», sin parciales y sin avisos de error; si falla se queda lo que había y el siguiente sondeo reintenta.
async function loadPruebas({ silent = false } = {}) {
  const p = state.pruebas;
  const runId = ++pruRun;
  let off = () => {};
  if (silent) {
    pruSilentRun = runId;
  } else {
    p.loading = true;
    renderPruebas();
    off = window.monstro.onPruebasProgress((board) => board.runId === runId && applyPruBoard(board));
  }
  try {
    const res = await window.monstro.pruebasBoard(runId);
    if (runId !== pruRun) return;
    p.loading = false;
    applyPruBoard(res, silent);
  } catch (err) {
    if (runId !== pruRun) return;
    p.loading = false;
    if (!silent) applyPruBoard({ tasks: p.tasks || [], errors: [{ task: "", error: String(err.message || err) }] });
  } finally {
    off();
    if (pruSilentRun === runId) pruSilentRun = 0;
  }
}

const pruTask = (key) => state.pruebas.tasks?.find((x) => x.key === key) || null;

// Las MRs de la tarjeta (esqueleto de la lista) con lo que trajo el detalle (jobs, estado, draft al día).
function pruMrs(task) {
  return task.mrs.map((m) => {
    const d = task.detail?.mrs.find((x) => x.projectId === m.projectId && x.iid === m.iid);
    return { jobs: [], state: "unknown", ...m, ...d };
  });
}

function pruStateChip(code) {
  const [text, tone] = PRU_STATE[code] || PRU_STATE.unknown;
  return `<span class="pru-state ${tone}">${esc(t(text))}</span>`;
}

// ▶ (job manual) o ↻ (fallido o cancelado). `action` y `confirm` los decide el main.
function pruActHtml(task, job) {
  if (!job.action) return "";
  const busy = state.pruebas.busy.has(job.id);
  const play = job.action === "play";
  return `<button class="pru-act" data-key="${esc(task.key)}" data-project="${job.projectId}" data-job="${job.id}" data-name="${esc(job.name)}" data-action="${job.action}" data-confirm="${job.confirm || ""}" ${busy ? "disabled" : ""} title="${play ? t("Lanzar job manual") : t("Reintentar job")}">${busy ? "…" : icon(play ? "play" : "rotate-ccw")}</button>`;
}

function pruJobHtml(task, job) {
  const [ico, cls] = JOB_ICON[job.status] || ["·", "muted"];
  const log = job.url ? `<a class="pru-log" data-url="${esc(job.url)}" href="#" title="${t("Ver log en GitLab")}">log</a>` : "";
  const reason = job.reason?.length ? `<pre class="pru-reason">${esc(job.reason.join("\n"))}</pre>` : "";
  return `<div class="pru-job ${cls}">
    <span class="pru-job-ico">${ico}</span><span class="pru-job-name" title="${esc(job.status)}">${esc(job.name)}</span>${pruActHtml(task, job)}${log}
  </div>${reason}`;
}

// Epic: crea la ronda `Epic #N` (como el bot). Siempre a mano; si ya hay una vigente, GitLab no crea otra y el aviso la enlaza.
function pruNewBtn(task) {
  const busy = state.pruebas.busy.has(`epic:${task.epicIid}`);
  return `<button class="btn pru-newpipe" data-key="${esc(task.key)}" ${busy ? "disabled" : ""}>${icon("plus")} ${t("Nuevo pipeline")}</button>`;
}

// Tarea sin epic u hotfix: «Run pipeline» de la pestaña Pipelines de GitLab, por MR.
function pruRunBtn(task, m) {
  const busy = state.pruebas.busy.has(`run:${m.projectId}!${m.iid}`);
  return `<button class="btn pru-runpipe" data-key="${esc(task.key)}" data-project="${m.projectId}" data-iid="${m.iid}" ${busy ? "disabled" : ""}>${icon("play")} ${t("Run pipeline")}</button>`;
}

function pruEpicHtml(task, epic) {
  if (!epic?.pipeline) {
    return `<div class="pru-epic"><div class="pru-epic-head"><span class="muted">${t("Esta epic no tiene pipeline")}</span>${pruNewBtn(task)}</div></div>`;
  }
  const link = `<a class="pru-pipelink" data-url="${esc(epic.pipeline.url)}" href="#">${t("Ver pipeline")} ${icon("arrow-right")}</a>`;
  return `<div class="pru-epic">
    <div class="pru-epic-head"><span>${t("Pipeline de la epic")} #${epic.pipeline.id}</span>${link}${pruNewBtn(task)}</div>
    <div class="pru-jobs">${epic.jobs.map((j) => pruJobHtml(task, j)).join("")}</div>
  </div>`;
}

function pruMrHtml(task, m) {
  const flow = m.jobs.filter((j) => j.flow);
  const other = m.jobs.filter((j) => !j.flow);
  const draft = m.draft ? `<span class="pru-badge">Draft</span>` : "";
  const conflict = m.mergeStatus === "conflict" || m.mergeStatus === "need_rebase" ? `<span class="pru-badge err">${t("Conflicto")}</span>` : "";
  const err = m.error ? `<div class="pru-error">${icon("triangle-alert")}${esc(m.error)}</div>` : "";
  const k = `${m.projectId}!${m.iid}`;
  return `<div class="pru-mr">
    <div class="pru-mr-head">
      <a class="pru-ref" data-url="${esc(m.url)}" href="#">${esc(m.repo)} !${m.iid}</a>
      <span class="pru-mr-title">${esc(m.title)}</span>${draft}${conflict}${pruStateChip(m.state)}${task.kind === "epic" ? "" : pruRunBtn(task, m)}
    </div>
    ${err}
    <div class="pru-jobs">${flow.map((j) => pruJobHtml(task, j)).join("")}</div>
    ${other.length ? `<details class="pru-other" data-k="${k}"${pruOpen.has(k) ? " open" : ""}><summary>${t("otros jobs ({n})", { n: other.length })}</summary><div class="pru-jobs">${other.map((j) => pruJobHtml(task, j)).join("")}</div></details>` : ""}
  </div>`;
}

// Etiquetas de la tarea (la de ciclo ya sale en la cabecera), las QA: primero.
function pruTagsHtml(task) {
  const tags = (task.labels || []).filter((l) => l !== task.label).sort(pruLabelOrder);
  return tags.length ? `<div class="pru-tags">${tags.map((l) => `<span class="pru-tag${pruIsQa(l) ? " qa" : ""}">${esc(l)}</span>`).join("")}</div>` : "";
}

// Un chip por etiqueta del grupo (con cuántas tareas la llevan; 0 = atenuado, por si un compañero la usa luego) más las
// elegidas aunque ya no existan, para poder quitarlas. Las QA: primero, luego las que tienen tareas.
function pruFilterHtml(tasks, picked, all) {
  const counts = new Map([...all, ...picked].map((l) => [l, 0]));
  for (const x of tasks) for (const l of x.labels || []) counts.set(l, (counts.get(l) || 0) + 1);
  if (!counts.size) return "";
  const chips = [...counts]
    .sort(([a, na], [b, nb]) => pruIsQa(b) - pruIsQa(a) || !na - !nb || a.localeCompare(b))
    .map(([l, n]) => {
      const on = picked.includes(l);
      return `<button class="pru-chip${pruIsQa(l) ? " qa" : ""}${on ? " on" : ""}${n ? "" : " zero"}" data-label="${esc(l)}" aria-pressed="${on}">${esc(l)} <span>${n}</span></button>`;
    })
    .join("");
  const clear = picked.length ? `<button class="pru-chip-clear" id="pru-clear-labels">${t("Quitar filtro")}</button>` : "";
  return `<div class="pru-filter" role="group" aria-label="${esc(t("Filtrar por etiqueta"))}">${chips}${clear}</div>`;
}

function pruCardHtml(task) {
  const d = task.detail;
  let body;
  if (task.error) body = `<div class="pru-error">${icon("triangle-alert")}${esc(task.error)}</div>`;
  else if (!d) body = `<div class="pru-loading loading-pulse">${t("Cargando…")}</div>`;
  else {
    const mrs = pruMrs(task);
    body =
      (task.kind === "epic" ? pruEpicHtml(task, d.epic) : "") +
      (mrs.length ? mrs.map((m) => pruMrHtml(task, m)).join("") : `<div class="muted">${t("Sin MRs abiertas")}</div>`);
  }
  return `<article class="pru-card" data-key="${esc(task.key)}">
    <header class="pru-card-head">
      <a class="pru-ref" data-url="${esc(task.url)}" href="#">${esc(task.ref)}</a>
      <span class="pru-title">${esc(task.title)}</span>
      ${task.label ? `<span class="pru-label">${esc(task.label)}</span>` : ""}
      ${d ? pruStateChip(d.state) : ""}
    </header>
    ${pruTagsHtml(task)}
    ${body}
  </article>`;
}

function renderPruebas() {
  if (state.view !== "pruebas") return;
  const p = state.pruebas;
  if (p.loading && !p.tasks) {
    list.innerHTML = `<div class="loading">${t("Cargando tareas y pipelines…")}</div>`;
    return;
  }
  const tasks = p.tasks || [];
  const errors = p.errors.map((e) => `<div class="pru-error">${icon("triangle-alert")}${esc(e.task ? `${e.task}: ${e.error}` : e.error)}</div>`).join("");
  const progress =
    p.loading && p.progress?.total
      ? `<span class="pru-progress">${icon("loader-circle", "spin")}${t("Cargando pipelines {l}/{n}", { l: p.progress.loaded, n: p.progress.total })}</span>`
      : "";
  const picked = p.labelFilter;
  const shown = picked.length ? tasks.filter((x) => picked.every((l) => (x.labels || []).includes(l))) : tasks;
  const groups = PRU_GROUPS.map((g) => {
    const mine = shown.filter(g.of);
    if (!mine.length) return "";
    return `<section class="pru-group"><h2>${t(g.label)}<span class="pru-count">${mine.length}</span></h2>${mine.map(pruCardHtml).join("")}</section>`;
  }).join("");
  list.innerHTML = `<div class="pru-view">
    <div class="pru-head">
      <div><h1>${t("Pruebas")}</h1><span class="muted">${t("Tareas por probar y su pipeline en GitLab")}</span></div>
      ${progress}
      <button class="icon-btn" id="pru-refresh" title="${t("Recargar")}" ${p.loading ? "disabled" : ""}>${icon("refresh-cw", p.loading ? "spin" : "")}</button>
    </div>
    ${errors}
    ${pruFilterHtml(tasks, picked, p.labels)}
    ${groups || (p.loading ? "" : `<div class="pru-empty">${tasks.length ? t("Ninguna tarea con esas etiquetas") : t("No hay tareas por probar")}</div>`)}
  </div>`;
  wirePruebas();
  if (!p.loading) notifySelftestOnce();
}

function wirePruebas() {
  $("#pru-refresh")?.addEventListener("click", () => loadPruebas());
  $("#pru-clear-labels")?.addEventListener("click", () => setPruLabels([]));
  list.querySelectorAll(".pru-chip").forEach((chip) => chip.addEventListener("click", () => togglePruLabel(chip.dataset.label)));
  list.querySelectorAll(".pru-newpipe").forEach((btn) =>
    btn.addEventListener("click", () => {
      const task = pruTask(btn.dataset.key);
      if (task) runPruNewPipeline(task);
    }),
  );
  list.querySelectorAll(".pru-runpipe").forEach((btn) =>
    btn.addEventListener("click", () => {
      const task = pruTask(btn.dataset.key);
      if (task) runPruMrPipeline(task, Number(btn.dataset.project), Number(btn.dataset.iid));
    }),
  );
  list.querySelectorAll(".pru-other").forEach((d) => d.addEventListener("toggle", () => (d.open ? pruOpen.add(d.dataset.k) : pruOpen.delete(d.dataset.k))));
  list.querySelectorAll(".pru-act").forEach((btn) =>
    btn.addEventListener("click", () => {
      const task = pruTask(btn.dataset.key);
      if (!task) return;
      const ds = { project: Number(btn.dataset.project), job: Number(btn.dataset.job), action: btn.dataset.action, name: btn.dataset.name, confirm: btn.dataset.confirm };
      if (ds.confirm) confirmPruAct(task, ds);
      else runPruAct(task, ds, "");
    }),
  );
  list.querySelectorAll("a[data-url]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      if (a.dataset.url) window.monstro.openExternal(a.dataset.url);
    }),
  );
}

/* ============ acciones ============ */

const PRU_CONFIRM = {
  merge: ["Mergear la tarea", "Mergea todas las MRs de la epic, back-ends primero. Solo funciona si eres Maintainer en todos los proyectos y no es atómico."],
  return: ["Devolver la tarea", "La epic pasa a needs fixing, se revocan los Approves y las MRs pasan a Draft."],
  "no-dev": ["Validar sin dev", "Esta MR no ha pasado por dev. Solo un Maintainer puede validarla así y queda registrado como «Validado SIN dev»."],
};

const closePruModal = () => ($("#modal-root").innerHTML = "");

// Recarga solo la tarjeta afectada (la lista y sus etiquetas no cambian por pulsar un job). `silent` (sondeo): si no
// cambió nada no repinta, y un fallo transitorio deja la tarjeta como estaba.
async function refreshPruTask(task, silent = false) {
  try {
    const detail = await window.monstro.pruebasTask(task.epicIid, task.mrs.map((m) => ({ projectId: m.projectId, iid: m.iid })));
    if (silent && JSON.stringify(detail) === JSON.stringify(task.detail)) return;
    task.detail = detail;
    task.error = null;
  } catch (err) {
    if (silent) return;
    task.error = String(err.message || err);
  }
  renderPruebas();
}

async function runPruAct(task, ds, motivo) {
  const p = state.pruebas;
  if (p.busy.has(ds.job)) return; // doble clic: una sola petición
  p.busy.add(ds.job);
  renderPruebas();
  try {
    await window.monstro.pruebasAct(ds.project, ds.job, ds.action, motivo);
    toast(t(ds.action === "play" ? "Lanzado: {job}" : "Reintentado: {job}", { job: ds.name }), "ok");
  } catch (err) {
    toast(`${ds.name}: ${String(err.message || err)}`, "err");
  } finally {
    p.busy.delete(ds.job);
  }
  await refreshPruTask(task);
}

// Mergear, devolver y validar sin dev piden confirmación; devolver admite un MOTIVO (solo al lanzar, no al reintentar).
function confirmPruAct(task, ds) {
  const [title, body] = PRU_CONFIRM[ds.confirm] || ["Confirmar", ""];
  const askMotivo = ds.confirm === "return" && ds.action === "play";
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal pru-modal">
        <h3>${esc(t(title))}</h3>
        <p>${esc(task.ref)} · ${esc(ds.name)}</p>
        <p>${esc(t(body))}</p>
        ${askMotivo ? `<textarea id="pru-motivo" class="pru-motivo" rows="3" maxlength="500" placeholder="${esc(t("Motivo (opcional): qué hay que arreglar"))}"></textarea>` : ""}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Confirmar")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", closePruModal);
  $("#modal-backdrop").addEventListener("click", (event) => event.target.id === "modal-backdrop" && closePruModal());
  $("#modal-confirm").addEventListener("click", () => {
    const motivo = askMotivo ? $("#pru-motivo").value.trim() : "";
    closePruModal();
    runPruAct(task, ds, motivo);
  });
}

// «Nuevo pipeline» de una epic: el aviso lleva al pipeline recién creado en GitLab y la tarjeta se recarga con él.
async function runPruNewPipeline(task) {
  const p = state.pruebas;
  const key = `epic:${task.epicIid}`;
  if (p.busy.has(key)) return; // doble clic: una sola ronda (el bot solo cancela las que crea él)
  p.busy.add(key);
  renderPruebas();
  try {
    const r = await window.monstro.pruebasNewPipeline(task.epicIid);
    const text = r.created
      ? t("Pipeline creado para la epic #{n}: clic para abrirlo y pulsar ▶ probar-tarea", { n: task.epicIid })
      : t("La epic #{n} ya tiene un pipeline vigente: clic para abrirlo", { n: task.epicIid });
    toast(text, r.created ? "ok" : "", () => r.url && window.monstro.openExternal(r.url));
  } catch (err) {
    toast(`#${task.epicIid}: ${String(err.message || err)}`, "err");
  } finally {
    p.busy.delete(key);
  }
  await refreshPruTask(task);
}

// «Run pipeline» de una MR de una tarea sin epic u hotfix (el de la pestaña Pipelines de la MR en GitLab).
async function runPruMrPipeline(task, projectId, iid) {
  const p = state.pruebas;
  const key = `run:${projectId}!${iid}`;
  if (p.busy.has(key)) return; // doble clic: un solo pipeline
  p.busy.add(key);
  renderPruebas();
  try {
    await window.monstro.pruebasRunMrPipeline(projectId, iid);
    toast(t("Pipeline lanzado en !{iid}", { iid }), "ok");
  } catch (err) {
    toast(`!${iid}: ${String(err.message || err)}`, "err");
  } finally {
    p.busy.delete(key);
  }
  await refreshPruTask(task);
}
