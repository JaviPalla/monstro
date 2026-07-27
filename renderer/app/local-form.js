// Crear tarea: formulario, campos markdown, propuesta de la IA y creación.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
function pickCurrentMilestoneId(ms) {
  const today = new Date().toISOString().slice(0, 10);
  const cur = (ms || []).find((m) => (!m.startDate || m.startDate <= today) && (!m.dueDate || m.dueDate >= today));
  return cur ? cur.id : null;
}

// Carga (cacheada) milestones del grupo + etiquetas disponibles, para el selector del formulario.
async function ensureLocalMeta() {
  const l = state.local;
  if (IS_SELFTEST) {
    if (!l.milestones) l.milestones = [{ id: 55, title: "Junio 2026", startDate: "2026-06-01", dueDate: "2026-06-30" }, { id: 56, title: "Julio 2026", startDate: "2026-07-01", dueDate: "2026-07-31" }];
    if (!l.groupLabels) l.groupLabels = [
      { name: "patient user", color: "#1f75cb", textColor: "#fff" }, { name: "professional user", color: "#6f42c1", textColor: "#fff" }, { name: "center user", color: "#1a7f37", textColor: "#fff" },
      { name: "high priority", color: "#dc3545", textColor: "#fff" }, { name: "medium priority", color: "#fd7e14", textColor: "#fff" }, { name: "low priority", color: "#6c757d", textColor: "#fff" },
      { name: "finished", color: "#1a7f37", textColor: "#fff" }, { name: "needs fixing", color: "#dc3545", textColor: "#fff" },
    ];
    return;
  }
  if (!l.milestones) l.milestones = await window.monstro.listMilestones().catch(() => []);
  if (!l.groupLabels) l.groupLabels = await window.monstro.groupLabels().catch(() => []);
}

function openLocalForm(dirs) {
  const l = state.local;
  const projects = (Array.isArray(dirs) ? dirs : [dirs])
    .map((dir) => {
      const repo = (l.repos || []).find((r) => r.dir === dir);
      if (!repo) return null;
      const info = l.info[dir] || {};
      const sourceBranch = info.current || (info.branches?.[0]?.name ?? "");
      return { repo, info, sourceBranch, targetBranch: "development", title: "", description: "", checklist: "", commitMessage: "", newBranch: "", createBranch: isBaseBranch(sourceBranch) };
    })
    .filter(Boolean);
  if (!projects.length) return;
  l.form = {
    epic: projects.length > 1,
    epicTitle: "",
    projects,
    mode: "ia", // "ia" | "manual"
    push: true,
    milestoneId: null,
    labels: new Set(),
    aiLoading: false,
    creating: false,
    result: null,
    error: null,
  };
  // Milestones + etiquetas (asíncrono): default = milestone actual por fechas.
  ensureLocalMeta().then(() => {
    if (state.local.form === l.form && l.form.milestoneId == null) l.form.milestoneId = pickCurrentMilestoneId(l.milestones);
    if (state.local.form === l.form) renderLocal();
  }).catch(() => {});
  renderLocal();
}

function closeLocalForm() {
  state.local.form = null;
  renderLocal();
}

// Lee los campos editables del DOM al estado (antes de re-render o de crear).
function syncLocalForm() {
  const f = state.local.form;
  if (!f) return;
  if (f.epic) f.epicTitle = $("#lf-epic-title")?.value ?? f.epicTitle;
  f.push = $("#lf-push") ? $("#lf-push").checked : f.push;
  f.projects.forEach((p, i) => {
    p.sourceBranch = $(`#lf-source-${i}`)?.value ?? p.sourceBranch;
    p.targetBranch = ($(`#lf-target-${i}`)?.value ?? p.targetBranch).trim();
    p.title = $(`#lf-title-${i}`)?.value ?? p.title;
    p.description = $(`#lf-desc-${i}`)?.value ?? p.description;
    p.checklist = $(`#lf-checklist-${i}`)?.value ?? p.checklist;
    p.commitMessage = $(`#lf-commit-${i}`)?.value ?? p.commitMessage;
    if ($(`#lf-nb-on-${i}`)) p.createBranch = $(`#lf-nb-on-${i}`).checked;
    p.newBranch = $(`#lf-nb-${i}`)?.value ?? p.newBranch;
  });
}

// Markdown → HTML SEGURO (subset: headings, listas, task lists, negrita/cursiva, código, enlaces
// http/https). Escapa primero y opera sobre texto ya escapado, así no hay inyección. Dependency-free
// (CSP estricta, sin libs). Solo para el preview del formulario; GitLab renderiza el markdown real.
function mdPreview(md) {
  if (!md || !md.trim()) return "";
  const parts = esc(md).split("```"); // pares = texto normal, impares = bloque de código
  return parts
    .map((part, i) => (i % 2 === 1 ? `<pre><code>${part.replace(/^\n/, "").replace(/\n$/, "")}</code></pre>` : renderMdBlocks(part)))
    .join("");
}

function renderMdBlocks(text) {
  const inline = (t) =>
    t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push("</ul>"); list = null; } };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { closeList(); const lvl = Math.min(m[1].length + 2, 6); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); }
    else if ((m = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) { if (list !== "task") { closeList(); out.push('<ul class="md-task">'); list = "task"; } out.push(`<li>${m[1].toLowerCase() === "x" ? "☑" : "☐"} ${inline(m[2])}</li>`); }
    else if ((m = /^[-*]\s+(.*)$/.exec(line))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) { closeList(); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join("");
}

// Campo markdown estilo GitLab: pestañas Editar / Vista previa sobre un textarea. `label` es HTML de
// confianza (de nuestro código); el valor se escapa. wireMdFields() cablea el toggle tras el render.
function mdField(id, label, value, rows, placeholder) {
  return `<div class="md-field">
    <div class="md-tabs">
      <span class="md-label">${label}</span>
      <button type="button" class="md-tab on" data-tab="write">${t("Editar")}</button>
      <button type="button" class="md-tab" data-tab="preview">${t("Vista previa")}</button>
    </div>
    <textarea id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
    <div class="md-preview hidden"></div>
  </div>`;
}

function wireMdFields() {
  list.querySelectorAll(".md-field").forEach((f) => {
    const ta = f.querySelector("textarea");
    const pv = f.querySelector(".md-preview");
    f.querySelectorAll(".md-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        const preview = tab.dataset.tab === "preview";
        f.querySelectorAll(".md-tab").forEach((t) => t.classList.toggle("on", t === tab));
        if (preview) pv.innerHTML = mdPreview(ta.value) || `<span class="muted">${t("Nada que previsualizar")}</span>`;
        pv.classList.toggle("hidden", !preview);
        ta.classList.toggle("hidden", preview);
      }),
    );
  });
}

// Ramas "base" sobre las que NO se debería trabajar directamente: sugerimos sacar una rama feature.
function isBaseBranch(name) {
  return ["development", "develop", "main", "master"].includes((name || "").trim());
}

function slug(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

// Extras por proyecto comunes a Crear y Vincular: (1) si la rama origen es una rama base, sugerir
// crear una rama feature; (2) si el repo tiene cambios sin commitear, pedir el mensaje del commit
// (al que el backend añade el "#ID" de la issue). `pfx` = "lf" (crear) | "llf" (vincular).
function localBranchExtras(p, i, pfx) {
  const feat = isBaseBranch(p.sourceBranch)
    ? `<div class="lf-feat">
        <label class="lf-check"><input type="checkbox" id="${pfx}-nb-on-${i}" ${p.createBranch ? "checked" : ""} /> ${t("Estás en <code>{b}</code>: crea una rama <b>feature</b> con estos cambios antes de la MR", { b: esc(p.sourceBranch) })}</label>
        ${p.createBranch ? `<input class="lf-nb" id="${pfx}-nb-${i}" type="text" value="${esc(p.newBranch)}" placeholder="feature/mi-cambio" />` : ""}
      </div>`
    : "";
  const commit = p.info?.dirty
    ? `<label class="lf-field">${t("Mensaje del commit")} <span class="muted">${t("(hay cambios sin commitear · se añadirá el #ID de la issue al final)")}</span><input id="${pfx}-commit-${i}" type="text" value="${esc(p.commitMessage)}" placeholder="${esc(t("Describe el cambio…"))}" /></label>`
    : "";
  return feat + commit;
}

// Bloque de campos de un proyecto dentro del form. En Epic, desc/checklist van en un <details> para
// no hacer el formulario kilométrico; en single van siempre visibles.
function localProjectBlock(p, i, epic) {
  const branches = p.info.branches || [];
  const branchOpts = branches.length
    ? branches.map((b) => `<option value="${esc(b.name)}" ${b.name === p.sourceBranch ? "selected" : ""}>${esc(b.name)}</option>`).join("")
    : `<option value="${esc(p.sourceBranch)}">${esc(p.sourceBranch || "—")}</option>`;
  const fields = `
    <div class="lf-row">
      <label>${t("Rama origen")}<select id="lf-source-${i}">${branchOpts}</select></label>
      <label>${t("Rama destino")}<input id="lf-target-${i}" type="text" value="${esc(p.targetBranch)}" placeholder="development" /></label>
    </div>
    ${localBranchExtras(p, i, "lf")}
    <label class="lf-field">${t("Título")}<input id="lf-title-${i}" type="text" value="${esc(p.title)}" placeholder="${esc(t("Título de la tarea"))}" /></label>
    ${mdField(`lf-desc-${i}`, t("Descripción"), p.description, epic ? 4 : 6, t("Propósito de la tarea (markdown)"))}
    ${mdField(`lf-checklist-${i}`, `${t("Puntos a comprobar")} <span class="muted">${t("(uno por línea)")}</span>`, p.checklist, epic ? 3 : 5, t("- Verificar que…"))}`;
  if (!epic) return `<div class="lf-proj">${fields}</div>`;
  return `<details class="lf-proj" open>
    <summary><span class="local-name">${esc(p.repo.name)}</span> <span class="local-badge ok">${esc(p.repo.gitlabPath)}</span></summary>
    ${fields}
  </details>`;
}

// Sección compartida de milestone + etiquetas (se aplican a la Issue/Epic y a todas las tareas).
const USER_LABELS = ["patient user", "professional user", "center user"];
const PRIO_LABELS = ["high priority", "medium priority", "low priority"];
function localMetaSection(f) {
  const l = state.local;
  const labelChip = (name) => {
    const meta = (l.groupLabels || []).find((x) => x.name === name);
    const on = f.labels.has(name);
    const style = on && meta ? ` style="background:${esc(meta.color)};color:${esc(meta.textColor)};border-color:${esc(meta.color)}"` : "";
    return `<button type="button" class="lbl-chip ${on ? "on" : ""}" data-label="${esc(name)}"${style}>${esc(name)}</button>`;
  };
  const others = (l.groupLabels || []).map((x) => x.name).filter((n) => !USER_LABELS.includes(n) && !PRIO_LABELS.includes(n));
  const msOpts = `<option value="">${esc(t("— sin milestone —"))}</option>` + (l.milestones || []).map((m) => `<option value="${m.id}" ${String(m.id) === String(f.milestoneId) ? "selected" : ""}>${esc(m.title)}</option>`).join("");
  return `
    <div class="lf-meta">
      <label class="lf-field">${t("Milestone")} <span class="muted">${t("(por defecto la actual por fechas)")}</span><select id="lf-milestone">${msOpts}</select></label>
      <div class="lf-labels">
        <div class="lbl-group"><span class="lbl-cat">${t("Tipo de usuario")}</span>${USER_LABELS.map(labelChip).join("")}</div>
        <div class="lbl-group"><span class="lbl-cat">${t("Prioridad")}</span>${PRIO_LABELS.map(labelChip).join("")}</div>
        ${others.length ? `<details class="lbl-more"><summary>${t("Más etiquetas ({n})", { n: others.length })}</summary><div class="lbl-group">${others.map(labelChip).join("")}</div></details>` : ""}
      </div>
    </div>`;
}

function renderLocalForm() {
  const f = state.local.form;
  const headTitle = f.epic ? t("Crear épica · {n} proyectos", { n: f.projects.length }) : t("Crear tarea · {name}", { name: esc(f.projects[0].repo.name) });
  const headDesc = f.epic
    ? t("Se creará una <b>Epic</b> y, en cada proyecto, una <b>Issue</b> + una <b>MR</b> vinculadas a la Epic.")
    : `${esc(f.projects[0].repo.gitlabPath)} — ${t("se creará una <b>Issue</b> y una <b>MR</b> con tu rama local.")}`;

  list.innerHTML = `
    <div class="local-head">
      <h2>${headTitle}</h2>
      <p class="local-desc">${headDesc}</p>
    </div>
    <div class="lf">
      <div class="lf-mode">
        <span>${t("Contenido:")}</span>
        <button class="lf-chip ${f.mode === "ia" ? "on" : ""}" id="lf-mode-ia">${t("✨ Generar con IA")}</button>
        <button class="lf-chip ${f.mode === "manual" ? "on" : ""}" id="lf-mode-manual">${t("✍️ A mano")}</button>
        ${f.mode === "ia" ? `<button class="btn" id="lf-suggest" ${f.aiLoading ? "disabled" : ""}>${f.aiLoading ? t("Generando…") : t("Sugerir con IA")}</button>` : ""}
      </div>
      ${f.error ? `<div class="error-box">${esc(f.error)}</div>` : ""}
      ${f.epic ? `<label class="lf-field">${t("Título de la Epic")}<input id="lf-epic-title" type="text" value="${esc(f.epicTitle)}" placeholder="${esc(t("Título de la Epic"))}" /></label>` : ""}
      ${f.projects.map((p, i) => localProjectBlock(p, i, f.epic)).join("")}
      ${localMetaSection(f)}
      <label class="lf-check"><input type="checkbox" id="lf-push" ${f.push ? "checked" : ""} /> ${t("Hacer push de las ramas a origin antes de crear las MR")}</label>
      <div class="lf-actions">
        <button class="btn" id="lf-cancel">${t("← Volver")}</button>
        <button class="btn btn-primary" id="lf-create" ${f.creating ? "disabled" : ""}>${f.creating ? t("Creando…") : f.epic ? t("Crear Epic + tareas") : t("Crear Issue + MR")}</button>
      </div>
    </div>`;

  $("#lf-cancel").addEventListener("click", closeLocalForm);
  $("#lf-mode-ia").addEventListener("click", () => { syncLocalForm(); f.mode = "ia"; renderLocal(); });
  $("#lf-mode-manual").addEventListener("click", () => { syncLocalForm(); f.mode = "manual"; renderLocal(); });
  $("#lf-suggest")?.addEventListener("click", suggestLocalTask);
  $("#lf-create").addEventListener("click", confirmCreateLocalTask);
  // Cambiar la rama origen o togglear "crear rama feature" re-renderiza (cambia qué extras se muestran).
  f.projects.forEach((_, i) => {
    $(`#lf-source-${i}`)?.addEventListener("change", () => { syncLocalForm(); renderLocal(); });
    $(`#lf-nb-on-${i}`)?.addEventListener("change", () => { syncLocalForm(); renderLocal(); });
  });
  $("#lf-milestone")?.addEventListener("change", (e) => { f.milestoneId = e.target.value ? Number(e.target.value) : null; });
  list.querySelectorAll(".lbl-chip").forEach((c) => c.addEventListener("click", () => { syncLocalForm(); const n = c.dataset.label; f.labels.has(n) ? f.labels.delete(n) : f.labels.add(n); renderLocal(); }));
  wireMdFields();
  notifySelftestOnce();
}

const checklistToText = (arr) => (Array.isArray(arr) && arr.length ? arr.map((c) => `- ${c}`).join("\n") : "");

// Vuelca una propuesta de IA (title/description/checklist/commitMessage) sobre un proyecto del form,
// y sugiere el nombre de la rama feature a partir del título si aún no se ha tocado.
function applyProposal(p, out) {
  p.title = out.title || p.title;
  p.description = out.description || p.description;
  if (out.checklist?.length) p.checklist = checklistToText(out.checklist);
  if (out.commitMessage) p.commitMessage = out.commitMessage;
  if (p.createBranch && (!p.newBranch || p.newBranch === "feature/") && p.title) p.newBranch = `feature/${slug(p.title)}`;
}

async function suggestLocalTask() {
  const f = state.local.form;
  syncLocalForm();
  f.aiLoading = true;
  f.error = null;
  renderLocal();
  try {
    if (f.epic) {
      const out = await window.monstro.localProposeEpic({
        projects: f.projects.map((p) => ({ dir: p.repo.dir, repoName: p.repo.gitlabPath || p.repo.name, sourceBranch: p.sourceBranch, targetBranch: p.targetBranch })),
      });
      f.epicTitle = out.epicTitle || f.epicTitle;
      out.projects.forEach((pr, i) => {
        if (!f.projects[i]) return;
        applyProposal(f.projects[i], pr);
      });
      (out.labels || []).forEach((n) => f.labels.add(n));
    } else {
      const p = f.projects[0];
      const out = await window.monstro.localProposeTask({ dir: p.repo.dir, repoName: p.repo.gitlabPath || p.repo.name, sourceBranch: p.sourceBranch, targetBranch: p.targetBranch });
      applyProposal(p, out);
      (out.labels || []).forEach((n) => f.labels.add(n));
    }
  } catch (err) {
    f.error = `${t("IA:")} ${String(err.message || err)}`;
  } finally {
    f.aiLoading = false;
    renderLocal();
  }
}

const parseChecklist = (text) => (text || "").split("\n").map((s) => s.replace(/^\s*[-*]\s?/, "").trim()).filter(Boolean);

function confirmCreateLocalTask() {
  const f = state.local.form;
  syncLocalForm();
  if (f.epic && !f.epicTitle.trim()) { f.error = t("El título de la Epic es obligatorio."); renderLocal(); return; }
  if (f.projects.some((p) => !p.title.trim())) { f.error = t("Cada proyecto necesita un título."); renderLocal(); return; }
  const summary = f.epic
    ? t("Se creará la <b>Epic</b> «{title}» y, en {n} proyectos, una <b>Issue</b> + una <b>MR</b> cada uno{push}. Acción irreversible.", { title: esc(f.epicTitle), n: f.projects.length, push: f.push ? t(", tras <b>pushear</b> las ramas") : "" })
    : t("En <b>{path}</b> se creará una <b>Issue</b> y una <b>MR</b> <code>{src} → {dst}</code>{push}. Acción irreversible.", { path: esc(f.projects[0].repo.gitlabPath), src: esc(f.projects[0].sourceBranch), dst: esc(f.projects[0].targetBranch), push: f.push ? t(", tras <b>pushear</b> la rama") : "" });
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("↗ Crear en GitLab")}</h3>
        <p class="muted">${summary}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Crear en GitLab")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; });
  $("#modal-confirm").addEventListener("click", () => { root.innerHTML = ""; createLocalTask(); });
}

// Payload por proyecto para los orquestadores (incluye mensaje de commit y rama feature opcional).
const localProjPayload = (p, push) => ({
  dir: p.repo.dir,
  projectPath: p.repo.gitlabPath,
  sourceBranch: p.sourceBranch,
  targetBranch: p.targetBranch,
  title: (p.title || "").trim(),
  description: p.description,
  checklist: parseChecklist(p.checklist),
  commitMessage: (p.commitMessage || "").trim(),
  newBranch: p.createBranch ? (p.newBranch || "").trim() : "",
  push,
});

async function createLocalTask() {
  const f = state.local.form;
  f.creating = true;
  f.error = null;
  renderLocal();
  try {
    const labels = [...f.labels];
    if (f.epic) {
      const res = await window.monstro.localCreateEpicTask({ epicTitle: f.epicTitle.trim(), epicDescription: "", labels, milestoneId: f.milestoneId, projects: f.projects.map((p) => localProjPayload(p, f.push)) });
      const ok = res.results.filter((x) => x.ok).length;
      toast(t("Epic + {ok}/{total} tareas creadas", { ok, total: res.results.length }), ok === res.results.length ? "ok" : "warn");
    } else {
      await window.monstro.localCreateTask({ ...localProjPayload(f.projects[0], f.push), labels, milestoneId: f.milestoneId });
      toast(t("Issue + MR creadas ✓"), "ok");
    }
    // #1: al terminar, llevar al histórico actualizado (con el detalle de lo creado y el log de pasos).
    state.local.form = null;
    state.local.selected.clear();
    await enterLocal("historico");
  } catch (err) {
    f.error = String(err.message || err);
    f.creating = false;
    toast(t("Error al crear"), "err");
    renderLocal();
  }
}

const extLink = (url, label) => `<a href="${esc(url)}" class="lf-result-link" data-ext>${esc(label)}</a>`;

// Deep-link interno: salta a la vista de MRs del repo de la MR creada y abre su detalle.
async function openLocalMrInMonstro(mr) {
  state.local.form = null;
  state.view = "prs";
  state.bucket = "open";
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector('[data-bucket="open"]')?.classList.add("active");
  if (state.config.repos.includes(mr.projectPath)) {
    state.repo = mr.projectPath;
    renderRepoSelect();
  }
  await refresh();
  try {
    await openDetail(mr.number, "conv", mr.projectPath);
  } catch {
    toast(t("Abre la MR desde la lista (puede tardar en aparecer)"), "");
  }
}

// ----- Vincular tarea: crear MR(s) ligadas a una Issue/Epic existente -----
