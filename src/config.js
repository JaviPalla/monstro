"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  // Proveedor: "github" | "gitlab". null = el onboarding aún no ha preguntado.
  provider: null,
  // Base de la API de GitLab (gitlab.com o instancia self-hosted). Solo se usa con provider "gitlab".
  gitlabBaseUrl: "https://gitlab.com",
  // Sin repos de fábrica: el onboarding ofrece los repos accesibles del usuario.
  repos: [],
  pollSeconds: 60,
  lastRepo: null,
  lastBucket: null,
  // Token manual SOLO como último recurso; lo normal es el CLI (gh/glab) o la env var.
  token: null,
  // Cherry-pick de hotfix tras merge (solo GitLab). Las MR de hotfix/* van a la release branch;
  // su contenido se replica a otras ramas (development + la rama hermana -mx, derivada del destino).
  cherryPick: {
    // Prefijo de rama origen que dispara el ofrecimiento de cherry-pick.
    prefix: "hotfix/",
    // Ramas destino fijas que siempre se proponen.
    branches: ["development"],
    // Además, proponer la rama hermana de la release branch destino (mx ⇄ sin mx).
    siblingMx: true,
  },
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    const cfg = { ...DEFAULTS, ...parsed };
    // Merge profundo de cherryPick: un guardado parcial no debe pisar los defaults del resto de claves.
    cfg.cherryPick = { ...DEFAULTS.cherryPick, ...(parsed.cherryPick || {}) };
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

module.exports = { load, save, configPath };
