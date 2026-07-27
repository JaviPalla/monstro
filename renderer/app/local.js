// Entrada de la vista (enterLocal) y carga de datos: repos locales, historial y estados.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
"use strict";

async function enterLocal(tab) {
  if (!isGitlab()) {
    toast(t("Trabajo local solo está disponible en GitLab"), "");
    return;
  }
  state.view = "local";
  if (tab) state.local.tab = tab;
  state.local.form = null;
  state.local.linkForm = null;
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  const bucketByTab = { empezar: "#bucket-local-empezar", vincular: "#bucket-local-vincular", historico: "#bucket-local-historico", crear: "#bucket-local-crear" };
  $(bucketByTab[state.local.tab] || "#bucket-local-crear")?.classList.add("active");
  if (state.local.tab === "historico") await loadLocalHistory();
  else if (state.local.tab === "empezar") await loadLocalStart();
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

