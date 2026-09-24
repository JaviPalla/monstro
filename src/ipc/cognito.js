"use strict";

// Handlers IPC de Usuarios (Cognito). Solo lecturas; perfil, región y pool salen de config.cognito.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const cognito = require("../cognito");

const POOL_RE = /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/;
// Sin comillas ni barras: el texto va dentro de un filtro `attr = "…"` de ListUsers.
const QUERY_RE = /^[^"\\]{0,128}$/;
const USERNAME_RE = /^[^"\\\s]{1,128}$/;

const checkPool = (poolId) => {
  if (typeof poolId !== "string" || !POOL_RE.test(poolId)) throw new Error("Pool no válida");
};

function register() {
  ipcMain.handle("cognito:profiles", () => cognito.profiles());
  ipcMain.handle("cognito:pools", () => cognito.pools());
  ipcMain.handle("cognito:users", (_event, { poolId, q }) => {
    checkPool(poolId);
    const query = typeof q === "string" ? q.trim() : "";
    if (!QUERY_RE.test(query)) throw new Error("Búsqueda no válida");
    return cognito.users(poolId, query);
  });
  ipcMain.handle("cognito:user", (_event, { poolId, username }) => {
    checkPool(poolId);
    if (typeof username !== "string" || !USERNAME_RE.test(username)) throw new Error("Usuario no válido");
    return cognito.user(poolId, username);
  });
  ipcMain.handle("cognito:console", (_event, { poolId, username }) => {
    checkPool(poolId);
    if (typeof username !== "string" || !USERNAME_RE.test(username)) throw new Error("Usuario no válido");
    return cognito.consoleUrl(poolId, username);
  });
}

module.exports = { register };
