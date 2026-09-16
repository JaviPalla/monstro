"use strict";

// Handlers IPC de pull/merge requests: listado, detalle, merge, comentarios, revisiones, borradores y ramas.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const agents = require("../agents");
const ai = require("../ai");
const config = require("../config");
const drafts = require("../drafts");
const local = require("../local");
const provider = require("../provider");

const gh = () => provider.current();

// Clon local del repo de la MR, si lo hay bajo el rootDir configurado. Con él la review es
// profunda (el agente lee el código de verdad); sin él, cae al one-shot con solo el diff.
async function localRepoDir(repoFullName) {
  const root = config.load().local.rootDir;
  if (!root || !repoFullName) return null;
  try {
    const repos = await local.scanRepos(root);
    return repos.find((r) => r.gitlabPath === repoFullName)?.dir || null;
  } catch {
    return null;
  }
}

function register() {
  ipcMain.handle("prs:list", async (_event, { repo, states }) => gh().listPRs(repo, states));
  ipcMain.handle("prs:search", async (_event, { repos, states }) => gh().searchPRs(repos, states));
  ipcMain.handle("pr:detail", async (_event, { repo, number }) => gh().prDetail(repo, number));
  ipcMain.handle("pr:merge", async (_event, { repo, number, deleteBranch, headRefName, isCrossRepository }) =>
    gh().mergePR(repo, number, { deleteBranch, headRefName, isCrossRepository }),
  );
  // Abre la rama de la MR en Rider / VS Code, en un worktree suyo: el clon del usuario no se toca.
  ipcMain.handle("pr:openEditor", async (_event, { repo, branch }) => {
    const dir = await localRepoDir(repo);
    if (!dir) throw new Error(`No encuentro el clon de ${repo} en tu carpeta de repos locales (Trabajo local → carpeta raíz).`);
    const worktree = await local.branchWorktree(dir, branch);
    return { ...agents.openEditor(worktree), worktree };
  });

  ipcMain.handle("pr:files", async (_event, { repo, number }) => gh().prFiles(repo, number));
  ipcMain.handle("pr:conversation", async (_event, { repo, number }) => gh().prConversation(repo, number));
  ipcMain.handle("pr:commentIssue", async (_event, { repo, number, body }) =>
    gh().addIssueComment(repo, number, body),
  );
  ipcMain.handle("pr:commentInline", async (_event, { repo, number, comment }) =>
    gh().addInlineComment(repo, number, comment),
  );
  ipcMain.handle("pr:replyThread", async (_event, { repo, number, commentDatabaseId, body }) =>
    gh().replyToThread(repo, number, commentDatabaseId, body),
  );
  ipcMain.handle("pr:resolveThread", async (_event, { threadId, resolved }) =>
    gh().setThreadResolved(String(threadId), Boolean(resolved)),
  );
  ipcMain.handle("pr:submitReview", async (_event, { repo, number, review }) =>
    gh().submitReview(repo, number, review),
  );
  // Solo cambia el texto de un borrador de review de GitLab (draft note): sigue sin publicarse.
  ipcMain.handle("pr:updateDraftNote", async (_event, { repo, number, draftNoteId, body }) => {
    if (!Number.isInteger(Number(number)) || !Number.isInteger(Number(draftNoteId))) throw new Error("Borrador no válido");
    if (!String(body || "").trim()) throw new Error("El borrador no puede quedar vacío");
    return gh().updateDraftNote(repo, Number(number), Number(draftNoteId), String(body));
  });
  // Borra un borrador de review de GitLab. No hay deshacer: el renderer pide confirmación antes.
  ipcMain.handle("pr:deleteDraftNote", async (_event, { repo, number, draftNoteId }) => {
    if (!Number.isInteger(Number(number)) || !Number.isInteger(Number(draftNoteId))) throw new Error("Borrador no válido");
    return gh().deleteDraftNote(repo, Number(number), Number(draftNoteId));
  });
  // Publica todos los borradores de review de GitLab de la MR. Solo tras clic + confirmación en el renderer.
  ipcMain.handle("pr:publishDraftNotes", async (_event, { repo, number }) => {
    if (!Number.isInteger(Number(number))) throw new Error("Número de MR no válido");
    return gh().publishDraftNotes(repo, Number(number));
  });

  ipcMain.handle("ai:status", () => ai.backendStatus());
  ipcMain.handle("ai:ping", async () => ai.ping());

  ipcMain.handle("drafts:list", (_event, { key }) => drafts.listFor(key));
  ipcMain.handle("drafts:save", (_event, { key, items }) => drafts.saveFor(key, items));
  ipcMain.handle("drafts:keys", () => drafts.allKeys());

  ipcMain.handle("history:branches", async (_event, { repo }) => gh().defaultBranch(repo));
  ipcMain.handle("history:graph", async (_event, { repo, branchSpecs }) => gh().branchHistories(repo, branchSpecs));
  const BRANCH_RE = /^[\w./-]{1,200}$/;
  ipcMain.handle("git:createBranch", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().createBranch(repo, branch, sha);
  });
  ipcMain.handle("git:forceUpdate", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().forceUpdateBranch(repo, branch, sha);
  });
  ipcMain.handle("pr:cherryPick", async (_event, { repo, sha, branch, dryRun }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().cherryPick(repo, sha, branch, { dryRun: Boolean(dryRun) });
  });
  ipcMain.handle("pr:mrCommits", async (_event, { repo, number }) => {
    if (!Number.isInteger(Number(number))) throw new Error("Número de MR no válido");
    return gh().mrCommits(repo, number);
  });
  ipcMain.handle("pr:revert", async (_event, { repo, number }) => {
    const nodeId = await gh().prNodeId(repo, number);
    return gh().revertPullRequest(nodeId);
  });
  ipcMain.handle("pr:setDraft", async (_event, { nodeId, toDraft }) => gh().setPrDraft(nodeId, Boolean(toDraft)));

}

module.exports = { register };
