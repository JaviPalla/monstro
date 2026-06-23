"use strict";

async function enterLocal(tab) {
  if (!isGitlab()) {
    toast("Trabajo local solo está disponible en GitLab", "");
    return;
  }
  state.view = "local";
  if (tab) state.local.tab = tab;
  state.local.form = null;
  state.local.linkForm = null;
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  const bucketByTab = { vincular: "#bucket-local-vincular", historico: "#bucket-local-historico", crear: "#bucket-local-crear" };
  $(bucketByTab[state.local.tab] || "#bucket-local-crear")?.classList.add("active");
  if (state.local.tab === "historico") await loadLocalHistory();
  else await loadLocal();
}

async function loadLocalHistory() {
  const l = state.local;
  l.loading = true;
  l.historyDetail = null;
  renderLocal();
  try {
    l.history = await window.monstro.localHistoryList();
  } catch {
    l.history = [];
  }
  l.loading = false;
  renderLocal();
  if (!IS_SELFTEST) refreshHistoryStatuses(); // #4b: estado en vivo (merged / etiquetas), best-effort
}

// Reúne los items (MRs + issues/tareas) del histórico y pide su estado real a GitLab para los badges.
async function refreshHistoryStatuses() {
  const items = [];
  for (const e of state.local.history || []) {
    if (e.kind === "tarea") {
      items.push({ type: "mr", projectPath: e.mr.projectPath, iid: e.mr.number }, { type: "issue", projectPath: e.issue.projectPath, iid: e.issue.iid });
    } else if (e.kind === "epic") {
      items.push({ type: "issue", projectPath: e.epic.projectPath, iid: e.epic.iid });
      (e.results || []).forEach((r) => { if (r.ok) { items.push({ type: "mr", projectPath: r.projectPath, iid: r.mr.number }); if (r.task) items.push({ type: "issue", projectPath: r.projectPath, iid: r.task.iid }); } });
    } else {
      items.push({ type: "issue", projectPath: e.issue.projectPath, iid: e.issue.iid });
      (e.results || []).forEach((r) => { if (r.ok) items.push({ type: "mr", projectPath: r.projectPath, iid: r.mr.number }); });
    }
  }
  try {
    state.local.historyStatus = (await window.monstro.localItemStatuses(items)) || {};
  } catch {
    return;
  }
  if (state.view === "local" && state.local.tab === "historico") renderLocal();
}

async function loadLocal() {
  const l = state.local;
  l.loading = true;
  l.info = {};
  renderLocal();
  try {
    const { rootDir, repos } = await window.monstro.localRepos();
    l.rootDir = rootDir;
    l.repos = repos;
    // Estado git (rama actual, ramas, worktrees, sucio) de cada repo, en paralelo: es git local, rápido.
    await Promise.all(
      repos.map(async (r) => {
        try {
          l.info[r.dir] = await window.monstro.localRepoInfo(r.dir);
        } catch (err) {
          l.info[r.dir] = { error: String(err.message || err) };
        }
      }),
    );
    l.loading = false;
    renderLocal();
    // Avatares de proyecto (groupProjects) en 2º plano: la lista se pinta ya con icono-letra y se
    // actualiza al llegar. Best-effort; se omite en selftest (la captura no debe esperar a la red).
    if (!IS_SELFTEST) ensureProjects().then(() => { if (state.view === "local" && state.local.tab !== "historico") renderLocal(); }).catch(() => {});
  } catch (err) {
    l.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

async function pickLocalRoot() {
  const { rootDir } = await window.monstro.localPickRoot();
  if (rootDir) await loadLocal();
}

const KIND_LABEL = { tarea: "Tarea", epic: "Epic", vincular: "Vinculación" };

// Enlace-pill tipado (Issue/Epic/MR/Commit) a GitLab. Reutilizado por la lista y el detalle.
const lhPill = (type, url, label) => `<a href="${esc(url)}" class="lh-pill lh-pill-${type}" data-ext>${esc(label)}</a>`;
// Badges de estado en vivo (#4b): MR merged/closed; issue cerrada + etiquetas importantes.
const IMPORTANT_LABEL_RE = /finished|pending check|needs fixing/i;
const lhMrBadge = (pp, num) => {
  const s = state.local.historyStatus[`mr:${pp}#${num}`];
  return s?.merged ? `<span class="lh-badge merged">merged</span>` : s?.state === "closed" ? `<span class="lh-badge closed">closed</span>` : "";
};
const lhIssueBadges = (pp, iid) => {
  const s = state.local.historyStatus[`issue:${pp}#${iid}`];
  if (!s) return "";
  const out = s.closed ? [`<span class="lh-badge closed">cerrada</span>`] : [];
  for (const lbl of s.labels || []) if (IMPORTANT_LABEL_RE.test(lbl)) out.push(`<span class="lh-badge lbl">${esc(lbl)}</span>`);
  return out.join("");
};
const lhDate = (ts) => { try { return new Date(ts).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" }); } catch { return ts || ""; } };
// ¿Algún paso o proyecto falló? (para el aviso ⚠ y que no pase desapercibido un push silencioso).
function entryHasWarning(e) {
  const stepBad = (steps) => (steps || []).some((s) => s && s.ok === false);
  if (e.kind === "tarea") return stepBad(e.steps);
  return (e.results || []).some((r) => !r.ok || stepBad(r.steps));
}

function renderLocalHistory() {
  if (state.local.historyDetail) return renderLocalHistoryDetail();
  const entries = state.local.history || [];
  const head = `
    <div class="local-head">
      <h2>Histórico</h2>
      <p class="local-desc">Trabajos creados desde Trabajo local, con los enlaces de GitLab de cada item. Pulsa una tarjeta para ver el detalle y el log de pasos.</p>
    </div>`;
  if (!entries.length) {
    list.innerHTML = head + `<div class="local-empty"><p>Aún no has creado ninguna tarea desde aquí.</p></div>`;
    notifySelftestOnce();
    return;
  }
  const projRow = (r, withTask) =>
    r.ok
      ? `<div class="lh-proj"><span class="lh-proj-name">${projectIconHtml(r.projectPath)}${esc(projectMeta(r.projectPath).name)}</span><span class="lh-proj-pills">${withTask && r.task ? lhPill("issue", r.task.url, `Tarea #${r.task.iid}`) + lhIssueBadges(r.projectPath, r.task.iid) : ""}${lhPill("mr", r.mr.url, `MR !${r.mr.number}`)}${lhMrBadge(r.projectPath, r.mr.number)}${r.commit ? lhPill("commit", r.commit.url, r.commit.sha.slice(0, 8)) : ""}</span></div>`
      : `<div class="lh-proj err"><span class="lh-proj-name">${esc(r.projectPath)}</span><span class="local-err">⚠ ${esc(r.error)}</span></div>`;
  const cards = entries
    .map((e) => {
      let items = "";
      if (e.kind === "tarea") {
        items = `<div class="lh-pills">${lhPill("issue", e.issue.url, `Issue #${e.issue.iid}`)}${lhIssueBadges(e.issue.projectPath, e.issue.iid)}${lhPill("mr", e.mr.url, `MR !${e.mr.number}`)}${lhMrBadge(e.mr.projectPath, e.mr.number)}${e.commit ? lhPill("commit", e.commit.url, `Commit ${e.commit.sha.slice(0, 8)}`) : ""}</div>`;
        if (e.projectPath) items = `<div class="lh-sub">${projectIconHtml(e.projectPath)}${esc(projectMeta(e.projectPath).name)}</div>` + items;
      } else if (e.kind === "epic") {
        items = `<div class="lh-pills">${lhPill("epic", e.epic.url, `Epic #${e.epic.iid}`)}${lhIssueBadges(e.epic.projectPath, e.epic.iid)}</div>${(e.results || []).map((r) => projRow(r, true)).join("")}`;
      } else {
        items = `<div class="lh-pills">${lhPill(e.issue.isEpic ? "epic" : "issue", e.issue.url, `${e.issue.isEpic ? "Epic" : "Issue"} ${e.issue.projectPath}#${e.issue.iid}`)}${lhIssueBadges(e.issue.projectPath, e.issue.iid)}</div>${(e.results || []).map((r) => projRow(r, false)).join("")}`;
      }
      const warn = entryHasWarning(e) ? `<span class="lh-warn" title="Algún paso no se completó — abre el detalle">⚠</span>` : "";
      return `
        <div class="lh-card lh-k-${esc(e.kind)}">
          <div class="lh-head">
            <span class="lh-kind lh-${esc(e.kind)}">${KIND_LABEL[e.kind] || esc(e.kind)}</span>
            <span class="lh-title">${esc(e.title || "(sin título)")}</span>
            ${warn}
            <time class="lh-date">${esc(lhDate(e.ts))}</time>
            <button class="lh-detail" data-id="${esc(e.id)}">Detalle →</button>
            <button class="lh-del" data-id="${esc(e.id)}" title="Quitar del histórico" aria-label="Quitar del histórico">✕</button>
          </div>
          <div class="lh-items">${items}</div>
        </div>`;
    })
    .join("");
  list.innerHTML = head + `<div class="lh-toolbar"><span class="muted">${entries.length} trabajo${entries.length === 1 ? "" : "s"}</span><button class="btn local-change" id="lh-clear">Vaciar histórico</button></div><div class="lh-list">${cards}</div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  list.querySelectorAll(".lh-detail").forEach((b) => b.addEventListener("click", () => { state.local.historyDetail = (state.local.history || []).find((x) => x.id === b.dataset.id) || null; renderLocal(); }));
  list.querySelectorAll(".lh-del").forEach((b) => b.addEventListener("click", async () => { state.local.history = await window.monstro.localHistoryRemove(b.dataset.id); renderLocal(); }));
  $("#lh-clear")?.addEventListener("click", async () => { state.local.history = await window.monstro.localHistoryClear(); renderLocal(); });
  notifySelftestOnce();
}

// Vista de detalle de una entrada del histórico: items con sus enlaces + el LOG DE PASOS (commit,
// push, rama feature…) por proyecto, para enterarse si algo no se completó (p.ej. un push silencioso).
function renderLocalHistoryDetail() {
  const e = state.local.historyDetail;
  const stepsHtml = (steps) =>
    (steps || []).length
      ? `<ul class="lh-steps">${steps.map((s) => `<li class="${s.ok === false ? "bad" : "good"}">${s.ok === false ? "✕" : "✓"} ${esc(s.text)}</li>`).join("")}</ul>`
      : `<p class="muted lh-nosteps">Sin pasos locales registrados.</p>`;
  let body = "";
  let primaryMr = null;
  if (e.kind === "tarea") {
    primaryMr = e.mr;
    body = `
      <div class="lh-d-block">
        <div class="lh-sub">${projectIconHtml(e.projectPath)}${esc(projectMeta(e.projectPath).name)}</div>
        <div class="lh-pills">${lhPill("issue", e.issue.url, `Issue #${e.issue.iid}`)}${lhPill("mr", e.mr.url, `MR !${e.mr.number}`)}${e.commit ? lhPill("commit", e.commit.url, `Commit ${e.commit.sha.slice(0, 8)}`) : ""}</div>
        ${stepsHtml(e.steps)}
      </div>`;
  } else {
    const top = e.kind === "epic"
      ? `<div class="lh-pills">${lhPill("epic", e.epic.url, `Epic #${e.epic.iid} · ${e.epic.title}`)}</div>`
      : `<div class="lh-pills">${lhPill(e.issue.isEpic ? "epic" : "issue", e.issue.url, `${e.issue.isEpic ? "Epic" : "Issue"} ${e.issue.projectPath}#${e.issue.iid} · ${e.issue.title}`)}</div>`;
    primaryMr = (e.results || []).find((r) => r.ok)?.mr || null;
    const blocks = (e.results || [])
      .map((r) => {
        const links = r.ok
          ? `<div class="lh-pills">${r.task ? lhPill("issue", r.task.url, `Tarea #${r.task.iid}`) : ""}${lhPill("mr", r.mr.url, `MR !${r.mr.number}`)}${r.commit ? lhPill("commit", r.commit.url, `Commit ${r.commit.sha.slice(0, 8)}`) : ""}</div>`
          : `<div class="local-err">⚠ ${esc(r.error)}</div>`;
        return `<div class="lh-d-block ${r.ok ? "" : "err"}"><div class="lh-sub">${projectIconHtml(r.projectPath)}${esc(projectMeta(r.projectPath).name)}</div>${links}${stepsHtml(r.steps)}</div>`;
      })
      .join("");
    body = top + blocks;
  }
  list.innerHTML = `
    <div class="local-head">
      <h2>${KIND_LABEL[e.kind] || esc(e.kind)} · ${esc(e.title || "")}</h2>
      <p class="local-desc">${esc(lhDate(e.ts))}</p>
    </div>
    <div class="lh-detail-body">${body}</div>
    <div class="lf-actions" style="margin:0 20px 28px">
      <button class="btn" id="lhd-back">← Volver al histórico</button>
      ${primaryMr ? `<button class="btn btn-accent" id="lhd-openmr">Ver MR en Monstro</button>` : ""}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  $("#lhd-back").addEventListener("click", () => { state.local.historyDetail = null; renderLocal(); });
  if (primaryMr) $("#lhd-openmr").addEventListener("click", () => { state.local.historyDetail = null; openLocalMrInMonstro(primaryMr); });
  notifySelftestOnce();
}

function renderLocal() {
  if (state.view !== "local") return;
  const l = state.local;
  if (l.loading) {
    list.innerHTML = `<div class="loading">Escaneando repos locales…</div>`;
    return;
  }
  if (l.form) return renderLocalForm();
  if (l.linkForm) return renderLocalLinkForm();
  if (l.tab === "historico") return renderLocalHistory();
  const isCrear = l.tab === "crear";
  const desc = isCrear
    ? "Elige repo y rama/worktree de tu local para crear una <b>Issue/Epic</b> nueva y su <b>MR</b>."
    : "Elige repo y rama/worktree de tu local para <b>vincular</b> el trabajo a una Issue/Epic existente y lanzar la <b>MR</b>.";
  const head = `
    <div class="local-head">
      <h2>${isCrear ? "Crear tarea" : "Vincular tarea"}</h2>
      <p class="local-desc">${desc}</p>
    </div>`;

  if (!l.rootDir) {
    list.innerHTML =
      head +
      `<div class="local-empty">
        <p>Aún no has indicado el <b>directorio raíz</b> donde tienes clonados tus repos de GitLab.</p>
        <button class="btn btn-primary" id="local-pick">Elegir directorio raíz…</button>
      </div>`;
    $("#local-pick")?.addEventListener("click", pickLocalRoot);
    notifySelftestOnce();
    return;
  }

  const repos = l.repos || [];
  // Las carpetas se AGRUPAN por su repo base de GitLab (mismo remote origin): varios worktrees/clones
  // del mismo proyecto quedan bajo una cabecera estilo chip de proyecto (icono + nombre). Las carpetas
  // sin remote de GitLab van a un grupo aparte. Seleccionar es por carpeta; 1 marcada = tarea, 2+ = Epic.
  const folderCard = (r) => {
    const info = l.info[r.dir] || {};
    const meta = info.error
      ? `<span class="local-err">${esc(info.error)}</span>`
      : `<span class="local-cur">⎇ ${esc(info.current || "—")}</span>
         ${info.dirty ? `<span class="local-dirty" title="Cambios sin commitear">● sucio</span>` : ""}
         <span class="local-count">${(info.branches || []).length} ramas · ${(info.worktrees || []).length} worktrees</span>`;
    const selectable = Boolean(r.gitlabPath);
    const checked = l.selected.has(r.dir);
    return `
      <div class="local-repo ${selectable ? "selectable" : ""} ${checked ? "checked" : ""}" ${selectable ? `data-dir="${esc(r.dir)}"` : ""}>
        <div class="local-repo-top">
          ${selectable ? `<input type="checkbox" class="local-cb" ${checked ? "checked" : ""} />` : ""}
          <span class="local-name">${esc(r.name)}</span>
        </div>
        <div class="local-repo-meta">${meta}</div>
      </div>`;
  };
  const groups = new Map();
  for (const r of repos) {
    const key = r.gitlabPath || "__none__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const cards = [...groups.entries()]
    .sort((a, b) => (a[0] === "__none__" ? 1 : b[0] === "__none__" ? -1 : projectMeta(a[0]).name.localeCompare(projectMeta(b[0]).name)))
    .map(([key, folders]) => {
      const known = folders[0].known;
      const groupHead =
        key === "__none__"
          ? `<div class="local-group-head"><span class="local-badge none">Sin remote de GitLab</span><span class="local-group-count">${folders.length} carpeta${folders.length === 1 ? "" : "s"}</span></div>`
          : `<div class="local-group-head">
              ${projectIconHtml(key)}
              <span class="ms-proj-name">${esc(projectMeta(key).name)}</span>
              <span class="local-group-path" title="${esc(key)}">${esc(key)}</span>
              ${known ? `<span class="local-badge ok" title="Proyecto configurado en Monstro">✓</span>` : ""}
              ${folders.length > 1 ? `<span class="local-group-count">${folders.length} carpetas</span>` : ""}
            </div>`;
      return `<div class="local-group">${groupHead}<div class="local-group-folders">${folders.map(folderCard).join("")}</div></div>`;
    })
    .join("");

  const selCount = l.selected.size;
  const btnLabel = isCrear ? (selCount > 1 ? "Crear épica →" : "Crear tarea →") : "Vincular →";
  const selNote = isCrear && selCount > 1 ? " · se creará una Epic" : "";
  const actionBar = repos.some((r) => r.gitlabPath)
    ? `<div class="local-actionbar">
        <span class="local-selcount">${selCount} seleccionado${selCount === 1 ? "" : "s"}${selNote}</span>
        <button class="btn btn-primary" id="local-continue" ${selCount ? "" : "disabled"}>${btnLabel}</button>
      </div>`
    : "";

  list.innerHTML =
    head +
    `<div class="local-root">
      <span class="local-root-path" title="${esc(l.rootDir)}">📁 ${esc(l.rootDir)}</span>
      <button class="btn local-change" id="local-pick">Cambiar…</button>
    </div>
    ${repos.length ? `<div class="local-repos">${cards}</div>` : `<div class="local-empty"><p>No se han encontrado repos git directamente bajo ese directorio.</p></div>`}
    ${repos.length ? `<p class="local-legend"><span class="local-dirty">● sucio</span> = el repo tiene cambios sin commitear; se commitearán (con tu mensaje + el #ID de la issue) al crear la tarea.</p>` : ""}
    ${actionBar}`;
  $("#local-pick")?.addEventListener("click", pickLocalRoot);
  list.querySelectorAll(".local-repo.selectable").forEach((el) =>
    el.addEventListener("click", () => {
      const dir = el.dataset.dir;
      if (l.selected.has(dir)) l.selected.delete(dir);
      else l.selected.add(dir);
      renderLocal();
    }),
  );
  $("#local-continue")?.addEventListener("click", () => (isCrear ? openLocalForm([...l.selected]) : openLocalLinkForm([...l.selected])));
  notifySelftestOnce();
}

// Abre el formulario para los repos `dirs` (1 = tarea single; 2+ = Epic). Siembra rama origen/destino.
// Milestone activo "actual" por fechas (start_date ≤ hoy ≤ due_date); si ninguno encaja, null.
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
      <button type="button" class="md-tab on" data-tab="write">Editar</button>
      <button type="button" class="md-tab" data-tab="preview">Vista previa</button>
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
        if (preview) pv.innerHTML = mdPreview(ta.value) || `<span class="muted">Nada que previsualizar</span>`;
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
        <label class="lf-check"><input type="checkbox" id="${pfx}-nb-on-${i}" ${p.createBranch ? "checked" : ""} /> Estás en <code>${esc(p.sourceBranch)}</code>: crea una rama <b>feature</b> con estos cambios antes de la MR</label>
        ${p.createBranch ? `<input class="lf-nb" id="${pfx}-nb-${i}" type="text" value="${esc(p.newBranch)}" placeholder="feature/mi-cambio" />` : ""}
      </div>`
    : "";
  const commit = p.info?.dirty
    ? `<label class="lf-field">Mensaje del commit <span class="muted">(hay cambios sin commitear · se añadirá el #ID de la issue al final)</span><input id="${pfx}-commit-${i}" type="text" value="${esc(p.commitMessage)}" placeholder="Describe el cambio…" /></label>`
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
      <label>Rama origen<select id="lf-source-${i}">${branchOpts}</select></label>
      <label>Rama destino<input id="lf-target-${i}" type="text" value="${esc(p.targetBranch)}" placeholder="development" /></label>
    </div>
    ${localBranchExtras(p, i, "lf")}
    <label class="lf-field">Título<input id="lf-title-${i}" type="text" value="${esc(p.title)}" placeholder="Título de la tarea" /></label>
    ${mdField(`lf-desc-${i}`, "Descripción", p.description, epic ? 4 : 6, "Propósito de la tarea (markdown)")}
    ${mdField(`lf-checklist-${i}`, `Puntos a comprobar <span class="muted">(uno por línea)</span>`, p.checklist, epic ? 3 : 5, "- Verificar que…")}`;
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
  const msOpts = `<option value="">— sin milestone —</option>` + (l.milestones || []).map((m) => `<option value="${m.id}" ${String(m.id) === String(f.milestoneId) ? "selected" : ""}>${esc(m.title)}</option>`).join("");
  return `
    <div class="lf-meta">
      <label class="lf-field">Milestone <span class="muted">(por defecto la actual por fechas)</span><select id="lf-milestone">${msOpts}</select></label>
      <div class="lf-labels">
        <div class="lbl-group"><span class="lbl-cat">Tipo de usuario</span>${USER_LABELS.map(labelChip).join("")}</div>
        <div class="lbl-group"><span class="lbl-cat">Prioridad</span>${PRIO_LABELS.map(labelChip).join("")}</div>
        ${others.length ? `<details class="lbl-more"><summary>Más etiquetas (${others.length})</summary><div class="lbl-group">${others.map(labelChip).join("")}</div></details>` : ""}
      </div>
    </div>`;
}

function renderLocalForm() {
  const f = state.local.form;
  const headTitle = f.epic ? `Crear épica · ${f.projects.length} proyectos` : `Crear tarea · ${esc(f.projects[0].repo.name)}`;
  const headDesc = f.epic
    ? `Se creará una <b>Epic</b> y, en cada proyecto, una <b>Issue</b> + una <b>MR</b> vinculadas a la Epic.`
    : `${esc(f.projects[0].repo.gitlabPath)} — se creará una <b>Issue</b> y una <b>MR</b> con tu rama local.`;

  list.innerHTML = `
    <div class="local-head">
      <h2>${headTitle}</h2>
      <p class="local-desc">${headDesc}</p>
    </div>
    <div class="lf">
      <div class="lf-mode">
        <span>Contenido:</span>
        <button class="lf-chip ${f.mode === "ia" ? "on" : ""}" id="lf-mode-ia">✨ Generar con IA</button>
        <button class="lf-chip ${f.mode === "manual" ? "on" : ""}" id="lf-mode-manual">✍️ A mano</button>
        ${f.mode === "ia" ? `<button class="btn" id="lf-suggest" ${f.aiLoading ? "disabled" : ""}>${f.aiLoading ? "Generando…" : "Sugerir con IA"}</button>` : ""}
      </div>
      ${f.error ? `<div class="error-box">${esc(f.error)}</div>` : ""}
      ${f.epic ? `<label class="lf-field">Título de la Epic<input id="lf-epic-title" type="text" value="${esc(f.epicTitle)}" placeholder="Título de la Epic" /></label>` : ""}
      ${f.projects.map((p, i) => localProjectBlock(p, i, f.epic)).join("")}
      ${localMetaSection(f)}
      <label class="lf-check"><input type="checkbox" id="lf-push" ${f.push ? "checked" : ""} /> Hacer push de las ramas a origin antes de crear las MR</label>
      <div class="lf-actions">
        <button class="btn" id="lf-cancel">← Volver</button>
        <button class="btn btn-primary" id="lf-create" ${f.creating ? "disabled" : ""}>${f.creating ? "Creando…" : f.epic ? "Crear Epic + tareas" : "Crear Issue + MR"}</button>
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
    f.error = `IA: ${String(err.message || err)}`;
  } finally {
    f.aiLoading = false;
    renderLocal();
  }
}

const parseChecklist = (text) => (text || "").split("\n").map((s) => s.replace(/^\s*[-*]\s?/, "").trim()).filter(Boolean);

function confirmCreateLocalTask() {
  const f = state.local.form;
  syncLocalForm();
  if (f.epic && !f.epicTitle.trim()) { f.error = "El título de la Epic es obligatorio."; renderLocal(); return; }
  if (f.projects.some((p) => !p.title.trim())) { f.error = "Cada proyecto necesita un título."; renderLocal(); return; }
  const summary = f.epic
    ? `Se creará la <b>Epic</b> «${esc(f.epicTitle)}» y, en ${f.projects.length} proyectos, una <b>Issue</b> + una <b>MR</b> cada uno${f.push ? ", tras <b>pushear</b> las ramas" : ""}. Acción irreversible.`
    : `En <b>${esc(f.projects[0].repo.gitlabPath)}</b> se creará una <b>Issue</b> y una <b>MR</b> <code>${esc(f.projects[0].sourceBranch)} → ${esc(f.projects[0].targetBranch)}</code>${f.push ? ", tras <b>pushear</b> la rama" : ""}. Acción irreversible.`;
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↗ Crear en GitLab</h3>
        <p class="muted">${summary}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Crear en GitLab</button>
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
      toast(`Epic + ${ok}/${res.results.length} tareas creadas`, ok === res.results.length ? "ok" : "warn");
    } else {
      await window.monstro.localCreateTask({ ...localProjPayload(f.projects[0], f.push), labels, milestoneId: f.milestoneId });
      toast("Issue + MR creadas ✓", "ok");
    }
    // #1: al terminar, llevar al histórico actualizado (con el detalle de lo creado y el log de pasos).
    state.local.form = null;
    state.local.selected.clear();
    await enterLocal("historico");
  } catch (err) {
    f.error = String(err.message || err);
    f.creating = false;
    toast("Error al crear", "err");
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
    toast("Abre la MR desde la lista (puede tardar en aparecer)", "");
  }
}

// ----- Vincular tarea: crear MR(s) ligadas a una Issue/Epic existente -----
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
    ? `<div class="loading">Buscando…</div>`
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
        ? `<div class="muted lf-field">Sin resultados.</div>`
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
          <label>Rama origen<select id="llf-source-${i}">${opts}</select></label>
          <label>Rama destino<input id="llf-target-${i}" type="text" value="${esc(p.targetBranch)}" placeholder="development" /></label>
        </div>
        ${localBranchExtras(p, i, "llf")}
        <label class="lf-field">Título de la MR<input id="llf-title-${i}" type="text" value="${esc(p.title)}" placeholder="Título de la MR" /></label>
      </div>`;
    })
    .join("");
  list.innerHTML = `
    <div class="local-head">
      <h2>Vincular tarea · ${f.projects.length} proyecto${f.projects.length === 1 ? "" : "s"}</h2>
      <p class="local-desc">Busca una <b>Issue o Epic</b> existente y crea una <b>MR</b> en cada proyecto vinculada a ella.</p>
    </div>
    <div class="lf">
      ${f.error ? `<div class="error-box">${esc(f.error)}</div>` : ""}
      <label class="lf-field">Issue / Epic destino<input id="llf-search" type="text" value="${esc(f.search)}" placeholder="Buscar por título… (Enter)" /></label>
      <div class="llf-results">${resultsHtml}</div>
      ${f.issue ? `<div class="llf-chosen">Vinculando a: <b>${esc(f.issue.title)}</b> <span class="muted">${esc(f.issue.projectPath)}#${esc(String(f.issue.iid))}</span></div>` : ""}
      ${projBlocks}
      <label class="lf-check"><input type="checkbox" id="llf-push" ${f.push ? "checked" : ""} /> Hacer push de las ramas antes de crear las MR</label>
      <div class="lf-actions">
        <button class="btn" id="llf-cancel">← Volver</button>
        <button class="btn btn-primary" id="llf-create" ${f.creating || !f.issue ? "disabled" : ""}>${f.creating ? "Creando…" : "Crear MR(s)"}</button>
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
  if (!f.issue) { f.error = "Elige una Issue/Epic."; renderLocal(); return; }
  if (f.projects.some((p) => !p.title.trim())) { f.error = "Cada proyecto necesita un título de MR."; renderLocal(); return; }
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↗ Vincular en GitLab</h3>
        <p class="muted">Se crearán ${f.projects.length} MR vinculadas a <b>${esc(f.issue.title)}</b> (${esc(f.issue.projectPath)}#${esc(String(f.issue.iid))})${f.push ? ", tras <b>pushear</b> las ramas" : ""}. Acción irreversible.</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Crear en GitLab</button>
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
    toast(`${ok}/${res.results.length} MR creadas`, ok === res.results.length ? "ok" : "warn");
    // #1: al terminar, al histórico actualizado.
    state.local.linkForm = null;
    state.local.selected.clear();
    await enterLocal("historico");
  } catch (err) {
    f.error = String(err.message || err);
    f.creating = false;
    toast("Error al vincular", "err");
    renderLocal();
  }
}

/* ---------- Releases · pestaña Publicar (tag + release) ---------- */

// CalVer base a partir de la rama rb/: "rb/062026" -> "2026.06". Si la rama no es rb/MMAAAA,
// se cae al mes actual (AAAA.MM). El patch (.0, .1…) lo resuelve el backend por proyecto.
