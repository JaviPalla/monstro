"use strict";

// Handlers IPC de agentes (OPE-20): arrancar, reanudar, parar, diff, finalizar y limpiar worktrees.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const agents = require("../agents");
const ai = require("../ai");
const local = require("../local");
const provider = require("../provider");

const gh = () => provider.current();

function register(ctx) {
  const { localRootGuard, planMarkdown } = ctx;
  ipcMain.handle("agents:start", async (_event, { title, url, isEpic, indications, objectives, requirements, tests, projects, taskProjectPath, taskIid }) => {
    const list = Array.isArray(projects) ? projects : [];
    if (!list.length) throw new Error("No hay proyectos sobre los que trabajar.");
    for (const p of list) localRootGuard(p.dir);
    let assigned = list.map(() => ({ model: "claude-sonnet-4-6", effort: "medium", rationale: "(orquestador no disponible)" }));
    try { assigned = (await ai.planAgents({ title, projects: list.map((p) => ({ name: p.name, tasks: p.tasks })) })).projects; }
    catch { /* si el orquestador falla, cada proyecto cae a un default razonable */ }
    const merged = list.map((p, i) => ({ ...p, model: assigned[i] && assigned[i].model, effort: assigned[i] && assigned[i].effort, rationale: assigned[i] && assigned[i].rationale }));
    // Requisito del usuario: el plan lanzado queda registrado como nota markdown en la Epic/Issue de
    // GitLab (no se pierde y todo el equipo lo ve). Best-effort: si falla, no aborta el lanzamiento.
    let planNote = null;
    if (taskProjectPath && Number.isInteger(taskIid)) {
      try { const c = await gh().addIssueComment(taskProjectPath, taskIid, planMarkdown({ title, indications, objectives, requirements, tests, projects: merged })); planNote = c && (c.url || c.html_url || true); }
      catch (err) { planNote = { error: String(err.message || err) }; }
    }
    return { ...(await agents.startRun({ title, url, isEpic, indications, objectives, requirements, tests, projects: merged })), planNote };
  });
  ipcMain.handle("agents:list", () => agents.listRuns());
  ipcMain.handle("agents:get", (_event, { runId }) => agents.getRun(runId));
  ipcMain.handle("agents:resume", (_event, { runId, projectDir, guidance }) => { localRootGuard(projectDir); return agents.resumeRun(runId, projectDir, guidance); });
  ipcMain.handle("agents:stop", (_event, { runId, projectDir }) => agents.stopRun(runId, projectDir));
  ipcMain.handle("agents:remove", (_event, { runId }) => agents.removeRun(runId));
  ipcMain.handle("agents:openEditor", (_event, { projectDir, worktree }) => { localRootGuard(projectDir); return agents.openEditor(projectDir, worktree); });
  // OPE-20 fase 4 (cierre): commit (si hay cambios) + push de la rama del worktree + crear la MR. A
  // golpe de click sobre un proyecto ya trabajado por el agente. Acción outward → solo por click.
  ipcMain.handle("agents:finalize", async (_event, { runId, projectDir, commitMessage }) => {
    const run = agents.getRun(runId);
    if (!run) throw new Error("Run no encontrado.");
    const proj = run.projects.find((p) => p.dir === projectDir);
    if (!proj || !proj.worktree) throw new Error("Proyecto/worktree no encontrado.");
    if (!proj.gitlabPath) throw new Error("El proyecto no tiene remote de GitLab.");
    localRootGuard(projectDir);
    const steps = [];
    let commit = null;
    if (await local.isDirty(proj.worktree)) {
      commit = await local.commitAll(proj.worktree, commitMessage || run.title);
      steps.push({ ok: true, text: commit ? `Commit ${commit.sha.slice(0, 8)}` : "Sin cambios que commitear" });
    }
    await local.pushBranch(proj.worktree, proj.branch);
    steps.push({ ok: true, text: `Push de ${proj.branch} a origin` });
    const desc = `${run.url ? `Relacionado: ${run.url}\n\n` : ""}${(proj.tasks || []).map((t) => `- ${t}`).join("\n")}`;
    const mr = await gh().createMergeRequest(proj.gitlabPath, { sourceBranch: proj.branch, targetBranch: proj.sourceBranch, title: run.title, description: desc });
    agents.updateProject(runId, projectDir, { mr, finalized: true, commit });
    return { mr, commit, steps };
  });
  // Diff de los cambios del agente (rama del worktree vs su base), para verlos DENTRO de la app.
  ipcMain.handle("agents:diff", async (_event, { projectDir, worktree, base, branch }) => {
    localRootGuard(projectDir);
    return { diff: (await local.branchDiff(worktree, base, branch)) || (await local.workingDiff(worktree)) };
  });
  // Estado de las MRs creadas (merged?), para mostrar el icono de limpiar el worktree stale.
  ipcMain.handle("agents:mrStatuses", async (_event, { runId }) => {
    const run = agents.getRun(runId);
    if (!run) return {};
    const out = {};
    for (const p of run.projects) if (p.mr) { try { out[p.dir] = await gh().mrStatus(p.mr.projectPath, p.mr.number); } catch { /* best-effort */ } }
    return out;
  });
  ipcMain.handle("agents:cleanupWorktree", async (_event, { runId, projectDir }) => { localRootGuard(projectDir); return agents.cleanupWorktree(runId, projectDir); });

  // Orquesta el flujo Vincular: por cada proyecto push → MR vinculada a la Issue/Epic existente.
  // Misma proyecto que la issue → "Closes #iid" (auto-cierra); otro proyecto/Epic → referencia cruzada.
}

module.exports = { register };
