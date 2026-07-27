"use strict";

// Handlers IPC de vincular tareas existentes y el histórico local de trabajos.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const localHistory = require("../localhistory");
const provider = require("../provider");

const gh = () => provider.current();

function register(ctx) {
  const { localRootGuard, prepareLocalBranch } = ctx;
  ipcMain.handle("local:linkTask", async (_event, { issue, projects }) => {
    const branchRe = /^[\w./-]{1,200}$/;
    const projRe = /^[\w.-]+(\/[\w.-]+)*$/;
    const list = Array.isArray(projects) ? projects : [];
    if (!issue || !issue.iid || !projRe.test(issue.projectPath || "")) throw new Error("Issue/Epic destino no válida");
    if (!list.length) throw new Error("Selecciona al menos un repo");
    const issueRef = `${issue.projectPath}#${issue.iid}`;
    const results = [];
    for (const p of list) {
      try {
        localRootGuard(p.dir);
        if (!projRe.test(p.projectPath || "")) throw new Error("Proyecto no válido");
        if (!branchRe.test(p.sourceBranch || "") || !branchRe.test(p.targetBranch || "")) throw new Error("Rama no válida");
        if (!p.title || !String(p.title).trim()) throw new Error("Falta el título de la MR");
        const { branch, commit, steps } = await prepareLocalBranch(p.dir, p.projectPath, { sourceBranch: p.sourceBranch, newBranch: p.newBranch, commitMessage: p.commitMessage, issueIid: issue.iid, push: p.push, fallbackMessage: String(p.title).trim() });
        const link = issue.projectPath === p.projectPath ? `Closes #${issue.iid}` : `Relacionada con ${issueRef}`;
        const mr = await gh().createMergeRequest(p.projectPath, { sourceBranch: branch, targetBranch: p.targetBranch, title: String(p.title).trim(), description: `${link}\n` });
        results.push({ projectPath: p.projectPath, ok: true, mr, commit, steps });
      } catch (err) {
        results.push({ projectPath: p.projectPath, ok: false, error: String(err.message || err) });
      }
    }
    localHistory.add({ kind: "vincular", title: issue.title, issue, results });
    return { issue, results };
  });
  // Histórico local de trabajos creados (tareas/epics/vinculaciones) con sus enlaces de GitLab.
  // Estado en vivo de los items del histórico (#4b): MR merged + estado/etiquetas de la issue. `items`
  // = [{type:"mr"|"issue", projectPath, iid}]; devuelve un mapa keyed por "type:projectPath#iid".
  ipcMain.handle("local:itemStatuses", async (_event, { items }) => {
    const out = {};
    await Promise.all(
      (Array.isArray(items) ? items : []).map(async (it) => {
        const key = `${it.type}:${it.projectPath}#${it.iid}`;
        try {
          out[key] = it.type === "mr" ? await gh().mrStatus(it.projectPath, it.iid) : await gh().issueStatus(it.projectPath, it.iid);
        } catch {
          /* item borrado o sin acceso: lo omitimos */
        }
      }),
    );
    return out;
  });
  ipcMain.handle("localHistory:list", () => localHistory.load());
  ipcMain.handle("localHistory:remove", (_event, { id }) => localHistory.remove(id));
  ipcMain.handle("localHistory:clear", () => localHistory.clear());

}

module.exports = { register };
