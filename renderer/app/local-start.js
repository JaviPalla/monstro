// Empezar tarea: listado de tareas propias, formulario de plan y lanzamiento de agentes.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
async function loadLocalStart() {
  const l = state.local;
  l.planForm = null;
  l.startSel = null;
  l.runView = null;
  if (!l.rootDir) { await loadLocal(); if (!l.rootDir) return; } // sin directorio raíz pinta el picker de raíz
  l.tasksLoading = true;
  renderLocal();
  try {
    l.tasks = await window.monstro.localMyTasks();
  } catch (err) {
    l.tasks = [];
    l.tasksError = String(err.message || err);
  }
  try { l.runs = (await window.monstro.agentsList()) || []; } catch { l.runs = []; }
  l.runsBadge = 0; // visto al entrar
  updateAgentsBadge();
  l.tasksLoading = false;
  renderLocal();
  if (!IS_SELFTEST) ensureProjects().then(() => { if (state.view === "local" && state.local.tab === "empezar" && !state.local.planForm) renderLocal(); }).catch(() => {});
}

// Etiquetas que marcan una tarea como "terminada o casi": se ocultan por defecto en el picker.
const DONE_TASK_RE = /pending check|finished/i;
const PRIORITY_META = ["high", "medium", "low", "none"].map((k, i) => ({ k, i }));
const priorityChip = (p) => {
  const label = { 0: "Alta", 1: "Media", 2: "Baja", 3: "—" }[p] ?? "—";
  const cls = { 0: "pri-high", 1: "pri-med", 2: "pri-low", 3: "pri-none" }[p] || "pri-none";
  return `<span class="ls-pri ${cls}" title="Prioridad ${label}">${label}</span>`;
};

// El picker: tareas (issues abiertas) del grupo asignadas a mí, por defecto sin las terminadas y
// ordenadas por prioridad. Filtros habituales (búsqueda + mostrar terminadas) encima.
function renderLocalStart() {
  const l = state.local;
  const head = `
    <div class="local-head">
      <h2>Empezar tarea</h2>
      <p class="local-desc">Elige una <b>Epic</b> o <b>Issue</b> asignada a ti para preparar un <b>plan</b> y, tras aprobarlo, lanzar a los agentes a trabajar en worktrees.</p>
    </div>`;
  if (!l.rootDir) {
    list.innerHTML = head + `<div class="local-empty"><p>Aún no has indicado el <b>directorio raíz</b> donde tienes clonados tus repos de GitLab.</p><button class="btn btn-primary" id="local-pick">Elegir directorio raíz…</button></div>`;
    $("#local-pick")?.addEventListener("click", async () => { await window.monstro.localPickRoot().then((r) => r.rootDir && loadLocalStart()); });
    notifySelftestOnce();
    return;
  }
  if (l.tasksLoading) { list.innerHTML = head + `<div class="loading">Cargando tus tareas…</div>`; return; }

  const f = l.startFilters;
  const q = f.query.trim().toLowerCase();
  const all = l.tasks || [];
  const tasks = all
    .filter((t) => f.showDone || !t.labels.some((lb) => DONE_TASK_RE.test(lb)))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || (t.projectPath || "").toLowerCase().includes(q))
    .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
  const hiddenDone = all.length - all.filter((t) => f.showDone || !t.labels.some((lb) => DONE_TASK_RE.test(lb))).length;

  const card = (t) => `
    <div class="ls-task" data-iid="${esc(String(t.iid))}" data-proj="${esc(t.projectPath || "")}">
      ${priorityChip(t.priority)}
      <span class="ls-kind ls-${t.isEpic ? "epic" : "issue"}">${t.isEpic ? "Epic" : "Issue"}</span>
      <div class="ls-main">
        <span class="ls-title">${esc(t.title)}</span>
        <span class="ls-proj">${t.projectPath ? projectIconHtml(t.projectPath) + esc(projectMeta(t.projectPath).name) : ""} <span class="muted">#${esc(String(t.iid))}</span></span>
      </div>
      <span class="ls-go">Preparar plan →</span>
    </div>`;

  const toolbar = `
    <div class="ls-toolbar">
      <input id="ls-q" class="ls-search" type="search" placeholder="Buscar por título o proyecto…" value="${esc(f.query)}" />
      <label class="ls-toggle"><input type="checkbox" id="ls-done" ${f.showDone ? "checked" : ""} /> Mostrar terminadas${hiddenDone > 0 && !f.showDone ? ` (${hiddenDone})` : ""}</label>
      <span class="muted ls-count">${tasks.length} tarea${tasks.length === 1 ? "" : "s"}</span>
      <button class="btn local-change" id="ls-refresh">↻ Recargar</button>
    </div>`;

  const body = l.tasksError
    ? `<div class="error-box">${esc(l.tasksError)}</div>`
    : tasks.length
      ? `<div class="ls-list">${tasks.map(card).join("")}</div>`
      : `<div class="local-empty"><p>No hay tareas asignadas a ti${f.showDone ? "" : " sin terminar"}.</p></div>`;

  // Trabajos en curso / recientes (runs persistidos): sobreviven a reiniciar la app y se pueden reanudar.
  const runs = l.runs || [];
  const runsSection = runs.length
    ? `<div class="lr-runs"><div class="lr-runs-head">Trabajos lanzados</div>${runs.slice(0, 8).map(runRowHtml).join("")}</div>`
    : "";

  list.innerHTML = head + runsSection + toolbar + body;
  list.querySelectorAll(".lr-run-row").forEach((el) => el.addEventListener("click", () => openRunView(el.dataset.run)));
  $("#ls-q")?.addEventListener("input", (e) => { f.query = e.target.value; renderLocalStartListOnly(); });
  $("#ls-done")?.addEventListener("change", (e) => { f.showDone = e.target.checked; renderLocal(); });
  $("#ls-refresh")?.addEventListener("click", () => loadLocalStart());
  list.querySelectorAll(".ls-task").forEach((el) => el.addEventListener("click", () => {
    const t = (l.tasks || []).find((x) => String(x.iid) === el.dataset.iid && (x.projectPath || "") === el.dataset.proj);
    if (t) openLocalPlanForm(t);
  }));
  notifySelftestOnce();
}
// Re-pinta solo al teclear en el buscador sin perder foco/caret del input habría sido lo ideal, pero
// el listado es pequeño: un render completo es suficiente. ponytail: full re-render, basta a esta escala.
function renderLocalStartListOnly() { renderLocal(); const i = $("#ls-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }

// Abre el formulario de plan para la tarea elegida. Carga el catálogo de modelos IA y fija por
// defecto el más alto (Opus 4.8 / max), pero el usuario puede cambiarlo (petición explícita).
async function openLocalPlanForm(task) {
  const l = state.local;
  const gitlabPaths = [...new Set((l.repos || []).map((r) => r.gitlabPath).filter(Boolean))];
  l.startSel = task;
  l.planForm = { task, indications: "", inferProjects: true, selectedRepos: new Set(), gitlabPaths, model: "claude-opus-4-8", effort: "max", aiModels: null, generating: false, plan: null, approved: false, error: null };
  renderLocal();
  if (IS_SELFTEST) {
    l.planForm.aiModels = [{ id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: ["low", "medium", "high", "max"] }];
    renderLocal();
    return;
  }
  try {
    const s = await window.monstro.aiStatus();
    if (l.planForm) { l.planForm.aiModels = Array.isArray(s.models) ? s.models : []; renderLocal(); }
  } catch { /* el selector cae a Opus/max por defecto */ }
}

function renderLocalPlanForm() {
  const l = state.local;
  const pf = l.planForm;
  const t = pf.task;
  const head = `
    <div class="local-head">
      <h2>Plan · ${esc(t.title)}</h2>
      <p class="local-desc">${t.isEpic ? "Epic" : "Issue"} ${t.projectPath ? esc(t.projectPath) : ""}#${esc(String(t.iid))} — el plan se genera con el modelo elegido (por defecto el más alto) y <b>tú lo apruebas</b> antes de ejecutar nada.</p>
    </div>`;

  // Selectores de modelo/esfuerzo construidos del catálogo (con fallback a Opus/max).
  const models = pf.aiModels || [{ id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"] }];
  const curModel = models.find((m) => m.id === pf.model) || models[0];
  const modelSel = `<select id="pf-model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === pf.model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>`;
  const effortSel = curModel.efforts.length
    ? `<select id="pf-effort">${curModel.efforts.map((e) => `<option value="${e}" ${e === pf.effort ? "selected" : ""}>esfuerzo: ${e}</option>`).join("")}</select>`
    : `<select id="pf-effort" disabled><option>esfuerzo: no aplicable</option></select>`;

  const projPicker = `
    <div class="pf-block">
      <label class="pf-label">Proyectos a tocar</label>
      <label class="ls-toggle"><input type="checkbox" id="pf-infer" ${pf.inferProjects ? "checked" : ""} /> Que los infiera la IA según la descripción</label>
      <div class="pf-projects ${pf.inferProjects ? "off" : ""}">
        ${pf.gitlabPaths.length ? pf.gitlabPaths.map((p) => `<label class="pf-proj"><input type="checkbox" class="pf-proj-cb" value="${esc(p)}" ${pf.selectedRepos.has(p) ? "checked" : ""} ${pf.inferProjects ? "disabled" : ""} /> ${projectIconHtml(p)}${esc(projectMeta(p).name)}</label>`).join("") : `<p class="muted">No hay repos locales casados con GitLab bajo el directorio raíz.</p>`}
      </div>
    </div>`;

  if (!pf.plan) {
    list.innerHTML = head + `
      <div class="pf-form">
        <div class="pf-block">
          <label class="pf-label" for="pf-ind">Indicaciones adicionales (opcional)</label>
          <textarea id="pf-ind" class="pf-textarea" rows="4" placeholder="Contexto, restricciones, prioridades… lo que quieras añadir antes de generar el plan.">${esc(pf.indications)}</textarea>
        </div>
        ${projPicker}
        <div class="pf-block pf-ai">
          <label class="pf-label">Modelo para el plan</label>
          <div class="pf-ai-row">${modelSel}${effortSel}</div>
          <p class="muted pf-hint">Para el plan se recomienda el modelo más alto; puedes bajarlo si quieres ahorrar.</p>
        </div>
        ${pf.error ? `<div class="error-box">${esc(pf.error)}</div>` : ""}
        <div class="lf-actions">
          <button class="btn" id="pf-back">← Volver</button>
          <button class="btn btn-primary" id="pf-gen" ${pf.generating ? "disabled" : ""}>${pf.generating ? "Generando plan…" : "Generar plan →"}</button>
        </div>
      </div>`;
    wirePlanFormInputs();
    $("#pf-back")?.addEventListener("click", () => { l.planForm = null; renderLocal(); });
    $("#pf-gen")?.addEventListener("click", generatePlan);
    notifySelftestOnce();
    return;
  }

  // Plan generado: render read-only + gate de aprobación.
  const plan = pf.plan;
  const ul = (items) => `<ul class="pf-ul">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const projs = plan.projects.map((p) => `
    <div class="pf-proj-plan">
      <div class="pf-proj-head">${projectIconHtml(p.name)}${esc(projectMeta(p.name).name || p.name)}</div>
      ${ul(p.tasks)}
    </div>`).join("");
  const meta = `${esc(plan.model)}${plan.effort ? ` · esfuerzo ${esc(plan.effort)}` : ""}${plan.backend ? ` · ${esc(plan.backend)}` : ""}`;

  // Mapeo plan→repo local: auto-asigna si el "name" del plan ES un path disponible; si no, lo deja
  // sin asignar para que el usuario lo elija (feedback: la IA a veces no infiere el proyecto correcto).
  pf.avail = availableLocalProjects();
  if (!pf.mapping) pf.mapping = plan.projects.map((p) => ({ theme: p.name, tasks: p.tasks, repoPath: pf.avail.some((a) => a.path === p.name) ? p.name : "" }));
  const mappedCount = pf.mapping.filter((m) => m.repoPath).length;
  const unresolved = pf.mapping.filter((m) => !m.repoPath).length;
  const mapRows = pf.mapping.map((m, i) => `
    <div class="pf-map-row">
      <span class="pf-map-theme ${m.repoPath ? "" : "unset"}">${esc(projectMeta(m.theme).name || m.theme)}</span>
      <span class="pf-map-arrow">→</span>
      <select class="pf-map-sel" data-i="${i}">
        <option value="">— sin asignar (se omite) —</option>
        ${pf.avail.map((a) => `<option value="${esc(a.path)}" ${m.repoPath === a.path ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
      </select>
    </div>`).join("");
  const mappingHtml = `<div class="pf-sec pf-map"><h3>🔗 Asignar a proyectos locales</h3>
    <p class="muted">Cada bloque se ejecuta en un repo <b>clonado en tu directorio raíz</b> y <b>seleccionable en la app</b>. ${unresolved ? `<b class="local-err">${unresolved} sin asignar</b> — elígelo en cada uno.` : "Todo asignado ✓"}</p>
    ${pf.avail.length ? mapRows : `<p class="local-err">No hay repos locales que casen con tus remotos seleccionables. Añádelos en Ajustes y clónalos bajo el directorio raíz.</p>`}</div>`;

  list.innerHTML = head + `
    <div class="pf-plan ${pf.approved ? "approved" : ""}">
      <div class="pf-plan-meta">Generado con <b>${meta}</b></div>
      ${plan.objectives.length ? `<div class="pf-sec"><h3>🎯 Objetivos</h3>${ul(plan.objectives)}</div>` : ""}
      ${plan.requirements.length ? `<div class="pf-sec"><h3>📋 Requisitos</h3>${ul(plan.requirements)}</div>` : ""}
      ${plan.projects.length ? `<div class="pf-sec"><h3>📦 Trabajo por proyecto</h3>${projs}</div>` : ""}
      ${mappingHtml}
      ${plan.tests.length ? `<div class="pf-sec"><h3>🧪 Pruebas a realizar</h3>${ul(plan.tests)}</div>` : ""}
      ${pf.approved ? `<div class="pf-approved-note">✓ Plan aprobado. Pulsa <b>Lanzar agentes</b>: un worktree + un agente autónomo por proyecto asignado. El plan se guardará como nota en la ${pf.task.isEpic ? "Epic" : "Issue"} de GitLab.${pf.launchError ? `<br><span class="local-err">⚠ ${esc(pf.launchError)}</span>` : ""}</div>` : ""}
    </div>
    <div class="lf-actions">
      <button class="btn" id="pf-edit">← Editar indicaciones</button>
      <button class="btn" id="pf-regen" ${pf.generating ? "disabled" : ""}>↻ Regenerar</button>
      ${pf.approved
        ? `<button class="btn btn-primary" id="pf-launch" ${pf.launching || !mappedCount ? "disabled" : ""} title="${mappedCount ? "" : "Asigna al menos un proyecto"}">${pf.launching ? "Lanzando…" : `🚀 Lanzar agentes${mappedCount ? ` (${mappedCount})` : ""}`}</button>`
        : `<button class="btn btn-primary" id="pf-approve" ${mappedCount ? "" : "disabled"} title="${mappedCount ? "" : "Asigna al menos un proyecto"}">Aprobar plan ✓</button>`}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  list.querySelectorAll(".pf-map-sel").forEach((sel) => sel.addEventListener("change", () => { pf.mapping[+sel.dataset.i].repoPath = sel.value; renderLocal(); }));
  $("#pf-edit")?.addEventListener("click", () => { pf.plan = null; pf.mapping = null; pf.approved = false; renderLocal(); });
  $("#pf-regen")?.addEventListener("click", generatePlan);
  $("#pf-approve")?.addEventListener("click", () => { pf.approved = true; renderLocal(); });
  $("#pf-launch")?.addEventListener("click", launchAgents);
  notifySelftestOnce();
}

// Resuelve el plan a repos locales y arranca el run (worktrees + agentes). Lo de verdad: dispara
// procesos reales. Por eso solo va tras "Aprobar plan" + "Lanzar agentes".
async function launchAgents() {
  const l = state.local;
  const pf = l.planForm;
  const plan = pf.plan;
  // Usa el MAPEO (theme→repo) que el usuario ha revisado/corregido. Cada bloque asignado se agrupa por
  // su repo (un repo puede recibir tareas de varios bloques); los "sin asignar" se omiten.
  const byPath = new Map((l.repos || []).filter((r) => r.gitlabPath).map((r) => [r.gitlabPath, r]));
  const matchedByRepo = new Map();
  const skipped = [];
  for (const m of pf.mapping || []) {
    const repo = m.repoPath && byPath.get(m.repoPath);
    if (!repo) { skipped.push(m.theme); continue; }
    if (!matchedByRepo.has(m.repoPath)) matchedByRepo.set(m.repoPath, { dir: repo.dir, name: m.repoPath, gitlabPath: m.repoPath, tasks: [], sourceBranch: "development" });
    matchedByRepo.get(m.repoPath).tasks.push(...(m.tasks || []));
  }
  const matched = [...matchedByRepo.values()];
  if (!matched.length) { pf.launchError = "Asigna al menos un bloque a un proyecto local antes de lanzar."; renderLocal(); return; }
  pf.launching = true;
  pf.launchError = skipped.length ? `Se omiten (sin asignar): ${skipped.join(", ")}` : null;
  renderLocal();
  try {
    const run = await window.monstro.agentsStart({
      title: pf.task.title, url: pf.task.url, isEpic: pf.task.isEpic, indications: pf.indications,
      objectives: plan.objectives, requirements: plan.requirements, tests: plan.tests, projects: matched,
      taskProjectPath: pf.task.projectPath, taskIid: pf.task.iid,
    });
    if (run.planNote && run.planNote.error) toast(`Run lanzado, pero no se pudo guardar el plan en GitLab: ${run.planNote.error}`, "err");
    else if (run.planNote) toast("Run lanzado · plan guardado en GitLab", "ok");
    l.runView = run;
    l.planForm = null;
    renderLocal();
  } catch (err) {
    pf.launching = false;
    pf.launchError = String(err.message || err);
    renderLocal();
  }
}

function wirePlanFormInputs() {
  const pf = state.local.planForm;
  $("#pf-ind")?.addEventListener("input", (e) => { pf.indications = e.target.value; });
  $("#pf-infer")?.addEventListener("change", (e) => { pf.inferProjects = e.target.checked; renderLocal(); });
  list.querySelectorAll(".pf-proj-cb").forEach((cb) => cb.addEventListener("change", () => { cb.checked ? pf.selectedRepos.add(cb.value) : pf.selectedRepos.delete(cb.value); }));
  $("#pf-model")?.addEventListener("change", (e) => { pf.model = e.target.value; const m = (pf.aiModels || []).find((x) => x.id === pf.model); pf.effort = m && m.efforts.length ? (m.efforts.includes("max") ? "max" : m.efforts[m.efforts.length - 1]) : null; renderLocal(); });
  $("#pf-effort")?.addEventListener("change", (e) => { pf.effort = e.target.value || null; });
}

// Proyectos candidatos para el plan/mapeo: repos LOCALES (bajo el directorio raíz, con remote GitLab)
// que ADEMÁS sean seleccionables en la app (config.repos). Dedup por gitlabPath. (Feedback del usuario.)
function availableLocalProjects() {
  const cfg = new Set(state.config?.repos || []);
  const seen = new Set();
  const out = [];
  for (const r of state.local.repos || []) {
    if (!r.gitlabPath || !cfg.has(r.gitlabPath) || seen.has(r.gitlabPath)) continue;
    seen.add(r.gitlabPath);
    out.push({ path: r.gitlabPath, name: projectMeta(r.gitlabPath).name || r.gitlabPath, dir: r.dir });
  }
  return out;
}

async function generatePlan() {
  const pf = state.local.planForm;
  if (!pf) return;
  // Captura el estado de los inputs antes de re-pintar (el textarea no dispara render en cada tecla).
  const ind = $("#pf-ind"); if (ind) pf.indications = ind.value;
  pf.generating = true;
  pf.error = null;
  pf.mapping = null; // se recalcula con el nuevo plan
  renderLocal();
  try {
    const repos = pf.inferProjects ? [] : [...pf.selectedRepos];
    pf.plan = await window.monstro.localProposePlan({
      title: pf.task.title,
      description: pf.task.description || "",
      isEpic: pf.task.isEpic,
      indications: pf.indications,
      repos,
      available: availableLocalProjects(),
      model: pf.model,
      effort: pf.effort,
    });
  } catch (err) {
    pf.error = String(err.message || err);
  } finally {
    pf.generating = false;
    renderLocal();
    notifySelftestOnce();
  }
}

/* ---------- OPE-20 fase 3: vista del run en vivo ---------- */

