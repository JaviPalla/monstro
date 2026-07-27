"use strict";

// Implementación del proveedor GitLab. Expone la MISMA interfaz pública que
// src/github.js y normaliza Merge Requests -> forma de "Pull Request" de GitHub,
// que es la que consume el renderer. Soporta gitlab.com y self-hosted (la base
// se lee de config.gitlabBaseUrl). Ver el contrato de enums más abajo: el
// renderer ramifica sobre valores literales exactos, no sobre la forma.

// Este fichero es solo la FACHADA: reexporta la interfaz pública para que src/provider.js
// y la paridad con src/github.js sigan viendo un único módulo. La implementación vive en
// src/gitlab/*.js. Añadir una función aquí = añadirla también a github.js (aunque sea un stub).

const core = require("./gitlab/core");
const prs = require("./gitlab/prs");
const issues = require("./gitlab/issues");
const environments = require("./gitlab/environments");
const releases = require("./gitlab/releases");

const all = { ...core, ...prs, ...issues, ...environments, ...releases };

module.exports = {
  resolveToken: all.resolveToken,
  invalidateTokenCache: all.invalidateTokenCache,
  viewer: all.viewer,
  viewerRepos: all.viewerRepos,
  listPRs: all.listPRs,
  searchPRs: all.searchPRs,
  prDetail: all.prDetail,
  mergePR: all.mergePR,
  updateBranchRebase: all.updateBranchRebase,
  defaultBranch: all.defaultBranch,
  branchHistories: all.branchHistories,
  prFiles: all.prFiles,
  prConversation: all.prConversation,
  addIssueComment: all.addIssueComment,
  addInlineComment: all.addInlineComment,
  replyToThread: all.replyToThread,
  setThreadResolved: all.setThreadResolved,
  dismissReview: all.dismissReview,
  submitReview: all.submitReview,
  createBranch: all.createBranch,
  forceUpdateBranch: all.forceUpdateBranch,
  cherryPick: all.cherryPick,
  mrCommits: all.mrCommits,
  revertPullRequest: all.revertPullRequest,
  setPrDraft: all.setPrDraft,
  prNodeId: all.prNodeId,
  listMilestones: all.listMilestones,
  milestoneIssues: all.milestoneIssues,
  milestoneEpicChildren: all.milestoneEpicChildren,
  projectIssues: all.projectIssues,
  issueMRs: all.issueMRs,
  groupLabels: all.groupLabels,
  groupProjects: all.groupProjects,
  updateIssue: all.updateIssue,
  createIssue: all.createIssue,
  createMergeRequest: all.createMergeRequest,
  createEpic: all.createEpic,
  createIssueLink: all.createIssueLink,
  mrStatus: all.mrStatus,
  issueStatus: all.issueStatus,
  searchGroupIssues: all.searchGroupIssues,
  listMyTasks: all.listMyTasks,
  collapseMilestoneEpics: all.collapseMilestoneEpics,
  releaseDefaults: all.releaseDefaults,
  generateReleaseBranches: all.generateReleaseBranches,
  nextReleaseTag: all.nextReleaseTag,
  createReleases: all.createReleases,
  releaseStatus: all.releaseStatus,
  projectEnvironments: all.projectEnvironments,
  releasePipeline: all.releasePipeline,
  playJob: all.playJob,
  createSnippet: all.createSnippet,
  saveMilestoneSummary: all.saveMilestoneSummary,
  mergeSummaryBlock: all.mergeSummaryBlock,
};
