"use strict";

// Handlers IPC de milestones, soporte, issues del grupo y el resumen de novedades.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const ai = require("../ai");
const provider = require("../provider");

const gh = () => provider.current();

function register() {
  ipcMain.handle("milestones:list", async () => gh().listMilestones());
  ipcMain.handle("milestones:issues", async (_event, { title, includeClosed }) =>
    gh().milestoneIssues(title, { includeClosed: Boolean(includeClosed) }),
  );
  ipcMain.handle("milestones:epicChildren", async (_event, { workItemId }) =>
    gh().milestoneEpicChildren(workItemId),
  );
  ipcMain.handle("milestones:issueMRs", async (_event, { workItemIds }) => gh().issueMRs(workItemIds || []));
  ipcMain.handle("support:list", async (_event, { project }) => {
    // El path llega del config (whitelist), no del renderer; validamos formato por si acaso.
    if (typeof project !== "string" || !/^[\w.-]+(\/[\w.-]+)+$/.test(project)) throw new Error("Proyecto de soporte inválido.");
    return gh().projectIssues(project);
  });
  ipcMain.handle("issues:groupLabels", async () => gh().groupLabels());
  ipcMain.handle("issues:groupProjects", async () => gh().groupProjects());
  ipcMain.handle("issues:update", async (_event, { projectId, iid, patch }) =>
    gh().updateIssue(projectId, iid, patch || {}),
  );
  ipcMain.handle("milestones:summary", async (_event, { milestoneTitle, issues }) => {
    const items = await gh().collapseMilestoneEpics(issues || []);
    return ai.summarizeMilestone({ milestoneTitle, items });
  });
  ipcMain.handle("milestones:publishSnippet", async (_event, { title, contentMarkdown }) =>
    gh().createSnippet({ title, contentMarkdown }),
  );

  ipcMain.handle("milestones:saveSummary", async (_event, { milestoneTitle, contentMarkdown }) => {
    if (typeof milestoneTitle !== "string" || !milestoneTitle.trim()) throw new Error("Milestone inválido.");
    if (typeof contentMarkdown !== "string" || !contentMarkdown.trim()) throw new Error("Resumen vacío.");
    // El resumen acaba en la descripción de un milestone compartido: cap defensivo por si un
    // milestone gigante genera un markdown desmedido (GitLab lo rechazaría con un 500 opaco).
    if (contentMarkdown.length > 100000) throw new Error("El resumen es demasiado largo para la descripción del milestone.");
    return gh().saveMilestoneSummary({ milestoneTitle: milestoneTitle.trim(), contentMarkdown });
  });

}

module.exports = { register };
