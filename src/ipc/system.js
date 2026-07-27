"use strict";

// Handlers IPC de sistema: abrir enlaces, notificaciones y badge del dock.
// Se registran desde wireIpc() en src/main.js.

const { app, ipcMain, Notification } = require("electron");

function register() {
  ipcMain.handle("shell:open", (_event, url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  });

  ipcMain.handle("notify", (_event, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
  });
  ipcMain.handle("dock:badge", (_event, text) => {
    app.dock?.setBadge(typeof text === "string" ? text : "");
  });
}

module.exports = { register };
