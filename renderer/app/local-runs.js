// Runs de agentes: estado, timeline, diff, finalizar y eventos en vivo.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
const RUN_STATUS = {
  starting: { label: "Arrancando", cls: "st-run" }, running: { label: "Trabajando", cls: "st-run" },
  done: { label: "Hecho", cls: "st-done" }, failed: { label: "Falló", cls: "st-fail" }, stopped: { label: "Parado", cls: "st-stop" }, idle: { label: "—", cls: "st-stop" },
};
const runStatusBadge = (s) => { const m = RUN_STATUS[s] || RUN_STATUS.idle; return `<span class="lr-status ${m.cls}">${m.label}</span>`; };
const TL_ICON = { say: "💬", tool: "▸", blocked: "⛔", result: "✓" };
const tlEntryHtml = (e) => `<li class="tl-${esc(e.kind)}"><span class="tl-ic">${e.kind === "result" ? (e.ok ? "✓" : "✗") : TL_ICON[e.kind] || "·"}</span><span class="tl-tx">${esc(e.text || "")}</span></li>`;

function runRowHtml(run) {
  const pend = (run.projects || []).reduce((n, p) => n + (p.pending || 0), 0);
  return `<div class="lr-run-row" data-run="${esc(run.id)}">
    ${runStatusBadge(run.status)}
    <span class="lr-run-title">${esc(run.title)}</span>
    <span class="muted lr-run-meta">${(run.projects || []).length} proyecto${(run.projects || []).length === 1 ? "" : "s"}${pend ? ` · ⛔ ${pend} pendiente${pend === 1 ? "" : "s"}` : ""}</span>
    <span class="ls-go">Ver →</span>
  </div>`;
}

async function openRunView(runId) {
  const l = state.local;
  try { l.runView = (await window.monstro.agentsGet(runId)) || l.runs.find((r) => r.id === runId) || null; }
  catch { l.runView = l.runs.find((r) => r.id === runId) || null; }
  if (l.runView) renderLocal();
}

function renderLocalRun() {
  const l = state.local;
  const run = l.runView;
  const projCard = (p, i) => {
    const running = p.status === "running" || p.status === "starting";
    const mrMerged = (l.mrStatuses[p.dir] || {}).merged;
    const modelChip = `<span class="lr-model" title="${esc(p.rationale || "")}">${esc(p.model || "")}${p.effort ? ` · ${esc(p.effort)}` : ""}</span>`;
    const timeline = (p.timeline || []).map(tlEntryHtml).join("") || `<li class="muted tl-empty">Sin actividad todavía…</li>`;
    return `
      <div class="lr-proj" data-dir="${esc(p.dir)}">
        <div class="lr-proj-head">
          ${projectIconHtml(p.gitlabPath || p.name)}<span class="lr-proj-name">${esc(projectMeta(p.gitlabPath || p.name).name || p.name)}</span>
          ${runStatusBadge(p.status)} ${modelChip} ${p.pending ? `<span class="lr-pend" title="Comandos peligrosos bloqueados">⛔ ${p.pending}</span>` : ""}
        </div>
        ${p.branch ? `<div class="lr-proj-sub">⎇ ${esc(p.branch)}${p.worktree ? ` · <span class="muted" title="${esc(p.worktree)}">.worktrees/${esc(p.worktree.split("/").pop())}</span>` : ""}</div>` : ""}
        ${p.error ? `<div class="local-err">⚠ ${esc(p.error)}</div>` : ""}
        <ul class="lr-timeline">${timeline}</ul>
        ${p.mr ? `<div class="lr-mr"><a href="${esc(p.mr.url)}" data-ext class="lh-pill lh-pill-mr">MR !${esc(String(p.mr.number))}</a>${mrMerged ? `<span class="lh-badge merged">merged</span>` : ""}</div>` : ""}
        <div class="lr-proj-actions">
          ${p.worktree && !p.worktreeRemoved ? `<button class="btn lr-open" data-dir="${esc(p.dir)}" data-wt="${esc(p.worktree)}">Abrir en editor</button>` : ""}
          ${p.worktree && !p.worktreeRemoved ? `<button class="btn lr-diff" data-dir="${esc(p.dir)}" data-wt="${esc(p.worktree)}" data-base="${esc(p.sourceBranch || "development")}" data-branch="${esc(p.branch || "")}">Ver cambios</button>` : ""}
          ${running
            ? `<button class="btn lr-stop" data-dir="${esc(p.dir)}">Parar</button>`
            : `${(p.status === "failed" || p.status === "stopped") && p.worktree ? `<button class="btn lr-retry" data-dir="${esc(p.dir)}" title="Vuelve a lanzar el agente en este worktree">↻ Reintentar</button>` : ""}<button class="btn lr-resume" data-dir="${esc(p.dir)}">Comentar y reanudar</button>`}
          ${!running && p.worktree && !p.finalized && p.gitlabPath ? `<button class="btn btn-primary lr-finalize" data-dir="${esc(p.dir)}">Finalizar (commit · push · MR)</button>` : ""}
          ${p.finalized && mrMerged && !p.worktreeRemoved ? `<button class="btn lr-clean" data-dir="${esc(p.dir)}" title="La MR está fusionada: limpia el worktree">🧹 Limpiar worktree</button>` : ""}
          ${p.worktreeRemoved ? `<span class="muted lr-cleaned">✓ worktree limpiado</span>` : ""}
        </div>
      </div>`;
  };
  list.innerHTML = `
    <div class="local-head">
      <h2>${esc(run.title)} ${runStatusBadge(run.status)}</h2>
      <p class="local-desc">Un agente autónomo trabaja en cada proyecto, en su worktree. Sigue su línea de tiempo en directo; los comandos peligrosos se bloquean (⛔) y requieren tu permiso.</p>
    </div>
    <div class="lr-grid">${(run.projects || []).map(projCard).join("")}</div>
    <div class="lf-actions" style="margin:0 20px 28px">
      <button class="btn" id="lr-back">← Volver</button>
      ${run.url ? `<a class="btn" href="${esc(run.url)}" data-ext>Ver la tarea en GitLab</a>` : ""}
      ${(run.projects || []).some((p) => (p.status === "failed" || p.status === "stopped") && p.worktree) ? `<button class="btn btn-primary" id="lr-retry-all">↻ Reintentar los que fallaron</button>` : ""}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  $("#lr-back")?.addEventListener("click", () => { l.runView = null; loadLocalStart(); });
  list.querySelectorAll(".lr-open").forEach((b) => b.addEventListener("click", async () => { const r = await window.monstro.agentsOpenEditor(b.dataset.dir, b.dataset.wt); toast(r.ok ? `Abriendo en ${r.stack === "dotnet" ? "Rider" : "VSCode"}…` : `No se pudo abrir: ${r.error || ""}`, r.ok ? "ok" : "err"); }));
  list.querySelectorAll(".lr-stop").forEach((b) => b.addEventListener("click", async () => { await window.monstro.agentsStop(run.id, b.dataset.dir); }));
  list.querySelectorAll(".lr-resume").forEach((b) => b.addEventListener("click", async () => {
    const guidance = prompt("Feedback para el agente (opcional). Lo retoma en el mismo worktree:");
    if (guidance === null) return;
    try { await window.monstro.agentsResume(run.id, b.dataset.dir, guidance.trim()); }
    catch (err) { toast(String(err.message || err), "err"); }
  }));
  list.querySelectorAll(".lr-retry").forEach((b) => b.addEventListener("click", () => retryProject(run.id, b.dataset.dir)));
  $("#lr-retry-all")?.addEventListener("click", async () => {
    const failed = (run.projects || []).filter((p) => (p.status === "failed" || p.status === "stopped") && p.worktree);
    for (const p of failed) await retryProject(run.id, p.dir);
  });
  list.querySelectorAll(".lr-diff").forEach((b) => b.addEventListener("click", () => openAgentDiff(b.dataset.dir, b.dataset.wt, b.dataset.base, b.dataset.branch)));
  list.querySelectorAll(".lr-finalize").forEach((b) => b.addEventListener("click", () => finalizeProject(b.dataset.dir, b)));
  list.querySelectorAll(".lr-clean").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { await window.monstro.agentsCleanupWorktree(run.id, b.dataset.dir); const p = run.projects.find((x) => x.dir === b.dataset.dir); if (p) p.worktreeRemoved = true; renderLocal(); toast("Worktree limpiado ✓", "ok"); }
    catch (err) { b.disabled = false; toast(String(err.message || err), "err"); }
  }));
  // Autoscroll de cada timeline al final.
  list.querySelectorAll(".lr-timeline").forEach((ul) => { ul.scrollTop = ul.scrollHeight; });
  // Estado de las MRs (merged?) para el icono de limpiar worktree — best-effort, no en selftest.
  if (!IS_SELFTEST && (run.projects || []).some((p) => p.mr)) {
    window.monstro.agentsMrStatuses(run.id).then((m) => { l.mrStatuses = { ...l.mrStatuses, ...(m || {}) }; if (state.local.runView === run) renderLocal(); }).catch(() => {});
  }
  notifySelftestOnce();
}

// Reintenta un proyecto que falló o se paró: vuelve a lanzar el agente en su mismo worktree (sin
// feedback). Si el agente llegó a tener sesión, se reanuda; si no (p.ej. crash al arrancar), arranca
// de cero. La timeline conserva el intento anterior como historial.
async function retryProject(runId, dir) {
  const run = state.local.runView;
  const p = run && run.projects.find((x) => x.dir === dir);
  if (p) { p.status = "starting"; p.error = null; renderLocal(); }
  try { await window.monstro.agentsResume(runId, dir, ""); toast("Reintentando…", "ok"); }
  catch (err) { if (p) p.status = "failed"; renderLocal(); toast(String(err.message || err), "err"); }
}

// Finaliza un proyecto: commit (si hay cambios) + push + crea la MR. Acción real → confirma vía botón.
async function finalizeProject(dir, btn) {
  const run = state.local.runView;
  if (btn) { btn.disabled = true; btn.textContent = "Finalizando…"; }
  try {
    const res = await window.monstro.agentsFinalize(run.id, dir);
    const p = run.projects.find((x) => x.dir === dir);
    if (p) { p.mr = res.mr; p.finalized = true; }
    renderLocal();
    toast(`MR creada: !${res.mr.number}`, "ok");
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Finalizar (commit · push · MR)"; }
    toast(String(err.message || err), "err");
  }
}

// Muestra el diff de los cambios del agente DENTRO de la app (modal con coloreado +/- básico).
async function openAgentDiff(dir, worktree, base, branch) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal modal-wide"><h3>Cambios · ${esc(branch)}</h3><div class="agent-diff loading">Cargando diff…</div><div class="modal-actions"><button class="btn" id="modal-cancel">Cerrar</button></div></div></div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-cancel").addEventListener("click", close);
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") close(); });
  try {
    const { diff } = await window.monstro.agentsDiff(dir, worktree, base, branch);
    const box = root.querySelector(".agent-diff");
    if (!box) return;
    box.classList.remove("loading");
    box.innerHTML = diff && diff.trim() ? `<pre class="agent-diff-pre">${renderDiffLines(diff)}</pre>` : `<p class="muted">Sin cambios respecto a ${esc(base)}.</p>`;
  } catch (err) {
    const box = root.querySelector(".agent-diff");
    if (box) { box.classList.remove("loading"); box.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`; }
  }
}

// Diff a HTML con clases por tipo de línea (+/-/hunk/cabecera). Escapado siempre.
function renderDiffLines(diff) {
  return String(diff).split("\n").map((ln) => {
    let cls = "d-ctx";
    if (/^diff --git|^index |^--- |^\+\+\+ /.test(ln)) cls = "d-meta";
    else if (ln.startsWith("@@")) cls = "d-hunk";
    else if (ln.startsWith("+")) cls = "d-add";
    else if (ln.startsWith("-")) cls = "d-del";
    return `<span class="${cls}">${esc(ln) || "&nbsp;"}</span>`;
  }).join("\n");
}

// Cuenta de runs que requieren atención (terminados/fallados desde la última visita o con pendientes).
function updateAgentsBadge() {
  const n = state.local.runsBadge || 0;
  const el = $("#bucket-local-empezar");
  if (!el) return;
  let dot = el.querySelector(".nav-dot");
  if (n > 0) { if (!dot) { dot = document.createElement("span"); dot.className = "nav-dot"; el.appendChild(dot); } dot.textContent = n > 9 ? "9+" : String(n); }
  else if (dot) dot.remove();
}

// Suscripción única a los eventos de los agentes: actualiza la vista del run en vivo + badge + avisos.
function wireAgentEvents() {
  window.monstro.onAgentEvent("agents:event", (p) => {
    const run = state.local.runView;
    const inView = run && run.id === p.runId;
    if (inView) {
      const proj = run.projects.find((x) => x.dir === p.projectDir);
      if (proj) {
        if (p.entries) { proj.timeline = (proj.timeline || []).concat(p.entries); if (p.entries.some((e) => e.kind === "blocked")) proj.pending = (proj.pending || 0) + p.entries.filter((e) => e.kind === "blocked").length; }
        if (p.status) proj.status = p.status;
        if (p.error) proj.error = p.error;
        if (p.mr) proj.mr = p.mr;
        if (p.finalized) proj.finalized = true;
        if (p.worktreeRemoved) proj.worktreeRemoved = true;
        // Append incremental al DOM si la vista está montada (evita perder scroll). Cambios de estado
        // que no son timeline (status/mr/finalized/limpieza) → re-render completo.
        const ul = list.querySelector(`.lr-proj[data-dir="${CSS.escape(p.projectDir)}"] .lr-timeline`);
        if (ul && p.entries && !p.status && !p.mr && !p.finalized && !p.worktreeRemoved) { ul.querySelector(".tl-empty")?.remove(); ul.insertAdjacentHTML("beforeend", p.entries.map(tlEntryHtml).join("")); ul.scrollTop = ul.scrollHeight; }
        else renderLocal();
      }
    }
  });
  window.monstro.onAgentEvent("agents:run", (p) => {
    if (state.local.runView && state.local.runView.id === p.runId) { state.local.runView.status = p.status; if (state.view === "local" && state.local.tab === "empezar" && state.local.runView) { const h = list.querySelector(".local-head h2 .lr-status"); if (h) h.outerHTML = runStatusBadge(p.status); } }
  });
  window.monstro.onAgentEvent("agents:notify", (p) => {
    const verb = p.status === "done" ? "terminó" : "falló";
    // Solo avisamos si NO estás mirando ese run (evita ruido), con burbuja + notificación OS.
    if (!(state.view === "local" && state.local.tab === "empezar" && state.local.runView && state.local.runView.id === p.runId)) {
      state.local.runsBadge = (state.local.runsBadge || 0) + 1;
      updateAgentsBadge();
      if (!IS_SELFTEST) window.monstro.notify(`Agente ${verb}`, `${p.projectName} · ${p.title}`);
    }
    toast(`Agente ${verb}: ${p.projectName}`, p.status === "done" ? "ok" : "err");
  });
}

/* ---------- Releases · pestaña Publicar (tag + release) ---------- */

// CalVer base a partir de la rama rb/: "rb/062026" -> "2026.06". Si la rama no es rb/MMAAAA,
// se cae al mes actual (AAAA.MM). El patch (.0, .1…) lo resuelve el backend por proyecto.
