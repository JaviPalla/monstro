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
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
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
