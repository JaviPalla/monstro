"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require("electron");
const config = require("./config");
const github = require("./github");

const SELFTEST = process.argv.includes("--selftest");
const SELFTEST_SHOT = "/tmp/pulpo-selftest.png";
const SELFTEST_TIMEOUT_MS = 20000;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 600,
    title: "Pulpo",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1f24" : "#f6f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: { selftest: SELFTEST ? "1" : "0" },
  });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function wireIpc() {
  ipcMain.handle("auth:status", async () => {
    const { token, source } = github.resolveToken();
    if (!token) return { ok: false, source: null, login: null };
    try {
      const me = await github.viewer();
      return { ok: true, source, login: me.login, avatarUrl: me.avatarUrl };
    } catch (err) {
      return { ok: false, source, login: null, error: String(err.message || err) };
    }
  });

  ipcMain.handle("config:get", () => {
    const { token, ...rest } = config.load();
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("config:set", (_event, partial) => {
    const allowed = {};
    if (Array.isArray(partial.repos)) allowed.repos = partial.repos.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
    if (Number.isInteger(partial.pollSeconds) && partial.pollSeconds >= 15) allowed.pollSeconds = partial.pollSeconds;
    if (typeof partial.token === "string") {
      allowed.token = partial.token.trim() || null;
      github.invalidateTokenCache();
    }
    const { token, ...rest } = config.save(allowed);
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("prs:list", async (_event, { repo, states }) => github.listPRs(repo, states));
  ipcMain.handle("pr:detail", async (_event, { repo, number }) => github.prDetail(repo, number));
  ipcMain.handle("pr:merge", async (_event, { repo, number, deleteBranch, headRefName, isCrossRepository }) =>
    github.mergePR(repo, number, { deleteBranch, headRefName, isCrossRepository }),
  );
  ipcMain.handle("pr:updateBranch", async (_event, { nodeId }) => github.updateBranchRebase(nodeId));
  ipcMain.handle("shell:open", (_event, url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

function wireSelftest() {
  let done = false;
  const finish = async () => {
    if (done || !win) return;
    done = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 900)); // deja asentar fuentes/avatares
      const image = await win.webContents.capturePage();
      fs.writeFileSync(SELFTEST_SHOT, image.toPNG());
      console.log(`[selftest] screenshot: ${SELFTEST_SHOT}`);
    } catch (err) {
      console.error("[selftest] capture failed:", err);
    } finally {
      app.quit();
    }
  };
  ipcMain.once("selftest:render-complete", finish);
  setTimeout(finish, SELFTEST_TIMEOUT_MS);
}

app.whenReady().then(() => {
  wireIpc();
  if (SELFTEST) wireSelftest();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
