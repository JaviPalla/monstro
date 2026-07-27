// Vincular una tarea ya existente: búsqueda de issues y creación de ramas/MRs.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
function openLocalLinkForm(dirs) {
  const l = state.local;
  const projects = (Array.isArray(dirs) ? dirs : [dirs])
    .map((dir) => {
      const repo = (l.repos || []).find((r) => r.dir === dir);
      if (!repo) return null;
      const info = l.info[dir] || {};
      const sourceBranch = info.current || (info.branches?.[0]?.name ?? "");
      return { repo, info, sourceBranch, targetBranch: "development", title: "", commitMessage: "", newBranch: "", createBranch: isBaseBranch(sourceBranch) };
    })
    .filter(Boolean);
  if (!projects.length) return;
  l.linkForm = { projects, issue: null, search: "", searching: false, results: [], push: true, creating: false, result: null, error: null };
  renderLocal();
}

function closeLocalLinkForm() {
  state.local.linkForm = null;
  renderLocal();
}

function syncLocalLinkForm() {
  const f = state.local.linkForm;
  if (!f) return;
  f.search = $("#llf-search")?.value ?? f.search;
  f.push = $("#llf-push") ? $("#llf-push").checked : f.push;
  f.projects.forEach((p, i) => {
    p.sourceBranch = $(`#llf-source-${i}`)?.value ?? p.sourceBranch;
    p.targetBranch = ($(`#llf-target-${i}`)?.value ?? p.targetBranch).trim();
    p.title = $(`#llf-title-${i}`)?.value ?? p.title;
    p.commitMessage = $(`#llf-commit-${i}`)?.value ?? p.commitMessage;
    if ($(`#llf-nb-on-${i}`)) p.createBranch = $(`#llf-nb-on-${i}`).checked;
    p.newBranch = $(`#llf-nb-${i}`)?.value ?? p.newBranch;
  });
}

function renderLocalLinkForm() {
  const f = state.local.linkForm;
  const resultsHtml = f.searching
    ? `<div class="loading">${t("Buscando…")}</div>`
    : f.results.length
      ? f.results
          .map(
            (r) => `<button class="llf-issue ${f.issue && f.issue.url === r.url ? "on" : ""}" data-url="${esc(r.url)}">
            <span class="local-badge ${r.isEpic ? "" : "ok"}">${r.isEpic ? "Epic" : "Issue"}</span>
            <span class="llf-issue-title">${esc(r.title)}</span>
            <span class="muted">${esc(r.projectPath)}#${esc(String(r.iid))}</span>
          </button>`,
          )
          .join("")
      : f.search
        ? `<div class="muted lf-field">${t("Sin resultados.")}</div>`
        : "";
  const projBlocks = f.projects
    .map((p, i) => {
      const branches = p.info.branches || [];
      const opts = branches.length
        ? branches.map((b) => `<option value="${esc(b.name)}" ${b.name === p.sourceBranch ? "selected" : ""}>${esc(b.name)}</option>`).join("")
        : `<option value="${esc(p.sourceBranch)}">${esc(p.sourceBranch || "—")}</option>`;
      return `<div class="lf-proj">
        <div class="lf-proj-name"><span class="local-name">${esc(p.repo.name)}</span> <span class="local-badge ok">${esc(p.repo.gitlabPath)}</span></div>
        <div class="lf-row">
          <label>${t("Rama origen")}<select id="llf-source-${i}">${opts}</select></label>
          <label>${t("Rama destino")}<input id="llf-target-${i}" type="text" value="${esc(p.targetBranch)}" placeholder="development" /></label>
        </div>
        ${localBranchExtras(p, i, "llf")}
        <label class="lf-field">${t("Título de la MR")}<input id="llf-title-${i}" type="text" value="${esc(p.title)}" placeholder="${esc(t("Título de la MR"))}" /></label>
      </div>`;
    })
    .join("");
  list.innerHTML = `
    <div class="local-head">
      <h2>${f.projects.length === 1 ? t("Vincular tarea · {n} proyecto", { n: f.projects.length }) : t("Vincular tarea · {n} proyectos", { n: f.projects.length })}</h2>
      <p class="local-desc">${t("Busca una <b>Issue o Epic</b> existente y crea una <b>MR</b> en cada proyecto vinculada a ella.")}</p>
    </div>
    <div class="lf">
      ${f.error ? `<div class="error-box">${esc(f.error)}</div>` : ""}
      <label class="lf-field">${t("Issue / Epic destino")}<input id="llf-search" type="text" value="${esc(f.search)}" placeholder="${esc(t("Buscar por título… (Enter)"))}" /></label>
      <div class="llf-results">${resultsHtml}</div>
      ${f.issue ? `<div class="llf-chosen">${t("Vinculando a:")} <b>${esc(f.issue.title)}</b> <span class="muted">${esc(f.issue.projectPath)}#${esc(String(f.issue.iid))}</span></div>` : ""}
      ${projBlocks}
      <label class="lf-check"><input type="checkbox" id="llf-push" ${f.push ? "checked" : ""} /> ${t("Hacer push de las ramas antes de crear las MR")}</label>
      <div class="lf-actions">
        <button class="btn" id="llf-cancel">${t("← Volver")}</button>
        <button class="btn btn-primary" id="llf-create" ${f.creating || !f.issue ? "disabled" : ""}>${f.creating ? t("Creando…") : t("Crear MR(s)")}</button>
      </div>
    </div>`;
  $("#llf-cancel").addEventListener("click", closeLocalLinkForm);
  $("#llf-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchLinkIssues(); } });
  list.querySelectorAll(".llf-issue").forEach((b) =>
    b.addEventListener("click", () => {
      syncLocalLinkForm();
      f.issue = f.results.find((r) => r.url === b.dataset.url) || null;
      if (f.issue && f.projects.every((p) => !p.title)) f.projects.forEach((p) => (p.title = f.issue.title));
      renderLocal();
    }),
  );
  $("#llf-create").addEventListener("click", confirmLinkTask);
  f.projects.forEach((_, i) => {
    $(`#llf-source-${i}`)?.addEventListener("change", () => { syncLocalLinkForm(); renderLocal(); });
    $(`#llf-nb-on-${i}`)?.addEventListener("change", () => { syncLocalLinkForm(); renderLocal(); });
  });
  notifySelftestOnce();
}

async function searchLinkIssues() {
  const f = state.local.linkForm;
  syncLocalLinkForm();
  if (!f.search.trim()) { f.results = []; renderLocal(); return; }
  f.searching = true;
  f.error = null;
  renderLocal();
  try {
    f.results = await window.monstro.localSearchIssues(f.search.trim());
  } catch (err) {
    f.error = String(err.message || err);
    f.results = [];
  } finally {
    f.searching = false;
    renderLocal();
  }
}

function confirmLinkTask() {
  const f = state.local.linkForm;
  syncLocalLinkForm();
  if (!f.issue) { f.error = t("Elige una Issue/Epic."); renderLocal(); return; }
  if (f.projects.some((p) => !p.title.trim())) { f.error = t("Cada proyecto necesita un título de MR."); renderLocal(); return; }
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("↗ Vincular en GitLab")}</h3>
        <p class="muted">${t("Se crearán {n} MR vinculadas a <b>{title}</b> ({path}#{iid}){push}. Acción irreversible.", { n: f.projects.length, title: esc(f.issue.title), path: esc(f.issue.projectPath), iid: esc(String(f.issue.iid)), push: f.push ? t(", tras <b>pushear</b> las ramas") : "" })}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Crear en GitLab")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; });
  $("#modal-confirm").addEventListener("click", () => { root.innerHTML = ""; createLinkTask(); });
}

async function createLinkTask() {
  const f = state.local.linkForm;
  f.creating = true;
  f.error = null;
  renderLocal();
  try {
    const res = await window.monstro.localLinkTask({ issue: f.issue, projects: f.projects.map((p) => localProjPayload(p, f.push)) });
    const ok = res.results.filter((x) => x.ok).length;
    toast(t("{ok}/{total} MR creadas", { ok, total: res.results.length }), ok === res.results.length ? "ok" : "warn");
    // #1: al terminar, al histórico actualizado.
    state.local.linkForm = null;
    state.local.selected.clear();
    await enterLocal("historico");
  } catch (err) {
    f.error = String(err.message || err);
    f.creating = false;
    toast(t("Error al vincular"), "err");
    renderLocal();
  }
}

/* ---------- OPE-20: Empezar tarea (picker + plan aprobable) ---------- */

// OPE-20: carga (best-effort) las tareas del grupo asignadas a mí para el picker de "Empezar tarea".
// El picker comparte el `rootDir`/repos con el resto de Trabajo local (para inferir/fijar proyectos
// en el plan), así que también escanea los repos locales si aún no se ha hecho.
