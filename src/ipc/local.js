"use strict";

// Handlers IPC de trabajo local: repos del disco, propuestas de la IA y creación de tareas/epics.
// Se registran desde wireIpc() en src/main.js.

const { app, ipcMain, dialog } = require("electron");
const path = require("path");
const ai = require("../ai");
const config = require("../config");
const local = require("../local");
const localHistory = require("../localhistory");
const provider = require("../provider");

const gh = () => provider.current();

function register(ctx) {
  const { SELFTEST, localRootGuard, prepareLocalBranch } = ctx;
  ipcMain.handle("local:pickRoot", async () => {
    const res = await dialog.showOpenDialog(ctx.win, { properties: ["openDirectory"], title: "Directorio raíz de tus repos" });
    if (res.canceled || !res.filePaths[0]) return { rootDir: config.load().local.rootDir };
    const { local: l } = config.save({ local: { ...config.load().local, rootDir: res.filePaths[0] } });
    return { rootDir: l.rootDir };
  });
  ipcMain.handle("local:repos", async () => {
    const cfg = config.load();
    // Selftest: si no hay rootDir configurado, escanea ~/repositories para que la captura muestre repos reales.
    const rootDir = cfg.local.rootDir || (SELFTEST ? path.join(app.getPath("home"), "repositories") : null);
    const repos = await local.scanRepos(rootDir);
    const known = new Set(cfg.repos);
    return { rootDir, repos: repos.map((r) => ({ ...r, known: r.gitlabPath ? known.has(r.gitlabPath) : false })) };
  });
  ipcMain.handle("local:repoInfo", async (_event, { dir }) => {
    localRootGuard(dir);
    return local.repoInfo(dir);
  });
  // Propuesta IA (título + descripción + checklist + mensaje de commit). Usa el diff de los cambios
  // SIN commitear (lo que se va a commitear); si no hay, cae al diff de la rama vs destino.
  ipcMain.handle("local:proposeTask", async (_event, { dir, sourceBranch, targetBranch, repoName }) => {
    localRootGuard(dir);
    const diffText = (await local.workingDiff(dir)) || (await local.branchDiff(dir, targetBranch, sourceBranch));
    return ai.proposeTask({ diffText, repoName, branch: sourceBranch });
  });
  // Orquesta el flujo Crear tarea (single-project): crea Issue → (opcional) rama feature → commitea
  // los cambios con "#<iid>" → push → crea MR (Closes #iid). Secuencial y NO atómico.
  ipcMain.handle("local:createTask", async (_event, { dir, projectPath, sourceBranch, targetBranch, title, description, checklist, labels, milestoneId, push, commitMessage, newBranch }) => {
    localRootGuard(dir);
    const branchRe = /^[\w./-]{1,200}$/;
    const projRe = /^[\w.-]+(\/[\w.-]+)*$/;
    if (!projRe.test(projectPath || "")) throw new Error("Proyecto no válido");
    if (!branchRe.test(sourceBranch || "") || !branchRe.test(targetBranch || "")) throw new Error("Rama no válida");
    if (!title || !String(title).trim()) throw new Error("El título es obligatorio");
    const checkItems = (Array.isArray(checklist) ? checklist : []).filter((c) => typeof c === "string" && c.trim());
    const checklistMd = checkItems.length ? `\n\n## Puntos a comprobar\n${checkItems.map((c) => `- [ ] ${c.trim()}`).join("\n")}` : "";
    const safeLabels = (Array.isArray(labels) ? labels : []).filter((l) => typeof l === "string" && l.trim());
    const me = await gh().viewer().catch(() => null); // asignar la tarea a mi usuario por defecto
    const assigneeIds = me?.id ? [me.id] : undefined;
    const mid = Number.isInteger(milestoneId) ? milestoneId : null;
    const issue = await gh().createIssue(projectPath, { title: String(title).trim(), description: `${description || ""}${checklistMd}`, labels: safeLabels, milestoneId: mid, assigneeIds });
    const { branch, commit, steps } = await prepareLocalBranch(dir, projectPath, { sourceBranch, newBranch, commitMessage, issueIid: issue.iid, push, fallbackMessage: String(title).trim() });
    const mr = await gh().createMergeRequest(projectPath, {
      sourceBranch: branch,
      targetBranch,
      title: String(title).trim(),
      description: `Closes #${issue.iid}\n\n${description || ""}${checklistMd}`,
    });
    localHistory.add({ kind: "tarea", title: issue.title, projectPath, issue, mr, commit, steps });
    return { issue, commit, branch, mr, steps };
  });
  // Propuesta IA para una Epic multiproyecto: calcula el diff de cada proyecto y se lo pasa a la IA.
  ipcMain.handle("local:proposeEpic", async (_event, { projects }) => {
    const list = Array.isArray(projects) ? projects : [];
    const withDiff = [];
    for (const p of list) {
      localRootGuard(p.dir);
      const diff = (await local.workingDiff(p.dir)) || (await local.branchDiff(p.dir, p.targetBranch, p.sourceBranch));
      withDiff.push({ name: p.repoName, branch: p.sourceBranch, diff });
    }
    return ai.proposeEpic({ projects: withDiff });
  });
  // Orquesta el flujo Epic multiproyecto: crea la Epic (issue en `${group}/epics`), luego por cada
  // proyecto push → Task (issue, referencia la Epic) → MR (Closes #task, referencia la Epic).
  // Secuencial y NO atómico: cada proyecto se reporta por separado; si la Epic falla, no sigue.
  ipcMain.handle("local:createEpicTask", async (_event, { epicTitle, epicDescription, projects, labels, milestoneId }) => {
    const branchRe = /^[\w./-]{1,200}$/;
    const projRe = /^[\w.-]+(\/[\w.-]+)*$/;
    const list = Array.isArray(projects) ? projects : [];
    if (!epicTitle || !String(epicTitle).trim()) throw new Error("El título de la Epic es obligatorio");
    if (list.length < 2) throw new Error("Una Epic necesita al menos 2 proyectos");
    const safeLabels = (Array.isArray(labels) ? labels : []).filter((l) => typeof l === "string" && l.trim());
    const me = await gh().viewer().catch(() => null);
    const assigneeIds = me?.id ? [me.id] : undefined;
    const mid = Number.isInteger(milestoneId) ? milestoneId : null;
    const epic = await gh().createEpic({ title: String(epicTitle).trim(), description: epicDescription || "", labels: safeLabels, milestoneId: mid, assigneeIds });
    const epicRef = `${epic.projectPath}#${epic.iid}`;
    const results = [];
    for (const p of list) {
      try {
        localRootGuard(p.dir);
        if (!projRe.test(p.projectPath || "")) throw new Error("Proyecto no válido");
        if (!branchRe.test(p.sourceBranch || "") || !branchRe.test(p.targetBranch || "")) throw new Error("Rama no válida");
        if (!p.title || !String(p.title).trim()) throw new Error("Falta el título de la tarea");
        const checkItems = (Array.isArray(p.checklist) ? p.checklist : []).filter((c) => typeof c === "string" && c.trim());
        const checklistMd = checkItems.length ? `\n\n## Puntos a comprobar\n${checkItems.map((c) => `- [ ] ${c.trim()}`).join("\n")}` : "";
        const task = await gh().createIssue(p.projectPath, { title: String(p.title).trim(), description: `Épica: ${epicRef}\n\n${p.description || ""}${checklistMd}`, labels: safeLabels, milestoneId: mid, assigneeIds });
        const { branch, commit, steps } = await prepareLocalBranch(p.dir, p.projectPath, { sourceBranch: p.sourceBranch, newBranch: p.newBranch, commitMessage: p.commitMessage, issueIid: task.iid, push: p.push, fallbackMessage: String(p.title).trim() });
        // Vincula la subtarea como linked item de la Epic (best-effort: no debe tumbar la creación).
        try {
          await gh().createIssueLink(epic.projectPath, epic.iid, task.projectId, task.iid);
          steps.push({ ok: true, text: `Vinculada como linked item de la Epic #${epic.iid}` });
        } catch (e) {
          steps.push({ ok: false, text: `No se pudo vincular a la Epic: ${String(e.message || e)}` });
        }
        const mr = await gh().createMergeRequest(p.projectPath, {
          sourceBranch: branch,
          targetBranch: p.targetBranch,
          title: String(p.title).trim(),
          description: `Closes #${task.iid}\nÉpica: ${epicRef}\n\n${p.description || ""}${checklistMd}`,
        });
        results.push({ projectPath: p.projectPath, ok: true, task, mr, commit, steps });
      } catch (err) {
        results.push({ projectPath: p.projectPath, ok: false, error: String(err.message || err) });
      }
    }
    localHistory.add({ kind: "epic", title: epic.title, epic, results });
    return { epic, results };
  });
  // Busca Issues/Epics abiertas del grupo (para el flujo Vincular tarea).
  ipcMain.handle("local:searchIssues", async (_event, { query }) => gh().searchGroupIssues(query));
  // OPE-20 "Empezar tarea": tareas (issues abiertas) del grupo asignadas a mí, para el picker.
  ipcMain.handle("local:myTasks", async () => gh().listMyTasks());
  // OPE-20: plan aprobable de la tarea elegida. Modelo/esfuerzo los elige el usuario (por defecto
  // el más alto). NO ejecuta nada: solo devuelve la propuesta de plan que el usuario aprobará.
  ipcMain.handle("local:proposePlan", async (_event, { title, description, isEpic, indications, repos, available, model, effort }) => {
    const safeRepos = (Array.isArray(repos) ? repos : []).filter((r) => typeof r === "string" && r.trim()).slice(0, 20);
    const safeAvail = (Array.isArray(available) ? available : []).filter((a) => a && typeof a.path === "string" && a.path.trim()).map((a) => ({ path: a.path, name: a.name || a.path })).slice(0, 60);
    return ai.proposePlan({ title, description, isEpic, indications, repos: safeRepos, available: safeAvail, model, effort });
  });
  // OPE-20 fase 3: arranca el run. El "orquestador" (ai.planAgents) decide modelo/esfuerzo por
  // proyecto (queda en el log del run); luego agents.startRun crea worktrees y lanza los agentes.
  // Acción que SÍ ejecuta procesos locales reales → solo se dispara por acción explícita del usuario.
}

module.exports = { register };
