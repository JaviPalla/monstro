"use strict";

// Handlers IPC de la sección Pruebas (solo GitLab). Se registran desde wireIpc() en src/main.js.
// Lo que manda el renderer no se da por bueno: src/pruebas-rules.js lo valida (proyectos del flujo,
// enteros positivos, motivo ≤ 500) y los permisos reales los decide GitLab con el token del usuario.

const { ipcMain } = require("electron");
const provider = require("../provider");
const rules = require("../pruebas-rules");

const gh = () => provider.current();

function register(ctx) {
  // Devuelve el tablero completo y, mientras, empuja parciales por "pruebas:progress" con el `runId`
  // de la petición (el renderer descarta los de una carga anterior).
  ipcMain.handle("pruebas:board", async (_event, { runId } = {}) =>
    gh().pruebasBoard((board) => {
      const win = ctx.win;
      if (win && !win.isDestroyed()) win.webContents.send("pruebas:progress", { runId, ...board });
    }),
  );

  // Recarga una sola tarjeta tras una acción.
  ipcMain.handle("pruebas:task", async (_event, payload) => gh().pruebasTask(rules.parseTaskRef(payload || {})));

  ipcMain.handle("pruebas:act", async (_event, payload) => {
    const a = rules.parseAct(payload || {});
    return gh().pruebasAct(a.project, a.jobId, a.kind, a.motivo);
  });

  ipcMain.handle("pruebas:newPipeline", async (_event, payload) => gh().pruebasNewPipeline(rules.parseEpicIid((payload || {}).epicIid)));

  ipcMain.handle("pruebas:runMrPipeline", async (_event, payload) => {
    const m = rules.parseMrRef(payload || {});
    return gh().pruebasRunMrPipeline(m.projectId, m.iid);
  });
}

module.exports = { register };
