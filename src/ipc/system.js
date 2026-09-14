"use strict";

// Handlers IPC de sistema: abrir enlaces, notificaciones y badge del dock.
// Se registran desde wireIpc() en src/main.js.

const { app, ipcMain, Notification, shell } = require("electron");

// Fuera de https solo se abren las URLs de "Probar en local": http en localhost o en un host local de opensalud.
const LOCAL_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+\.opensalud\.(es|mx))(:\d{1,5})?(\/|$)/i;

// Avisos vivos: si nadie los referencia, el GC se lleva el Notification y su click deja de llegar.
const shown = new Set();

function register(ctx) {
  ipcMain.handle("shell:open", (_event, url) => {
    if (typeof url === "string" && (/^https:\/\//.test(url) || LOCAL_HTTP_RE.test(url))) shell.openExternal(url);
  });

  // `sessionId` (avisos de Agents): el click trae la ventana al frente y le dice al renderer qué ficha abrir.
  ipcMain.handle("notify", (_event, { title, body, sessionId }) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: String(title), body: String(body) });
    shown.add(note);
    note.on("close", () => shown.delete(note));
    note.on("click", () => {
      shown.delete(note);
      const win = ctx.win;
      if (!win || typeof sessionId !== "string") return;
      win.show();
      win.webContents.send("notify:session", sessionId);
    });
    note.show();
  });
  ipcMain.handle("dock:badge", (_event, text) => {
    app.dock?.setBadge(typeof text === "string" ? text : "");
  });
}

module.exports = { register };
