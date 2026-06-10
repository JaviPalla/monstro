"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pulpo", {
  authStatus: () => ipcRenderer.invoke("auth:status"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),
  listPRs: (repo, states) => ipcRenderer.invoke("prs:list", { repo, states }),
  prDetail: (repo, number) => ipcRenderer.invoke("pr:detail", { repo, number }),
  mergePR: (args) => ipcRenderer.invoke("pr:merge", args),
  updateBranch: (nodeId) => ipcRenderer.invoke("pr:updateBranch", { nodeId }),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  selftestRenderComplete: () => ipcRenderer.send("selftest:render-complete"),
});
