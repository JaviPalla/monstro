"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/**
 * Borradores de comentarios de review, 100% locales (no tocan GitHub hasta
 * que el usuario publica). Clave: "owner/repo#number" → array de items:
 *   { id, kind: "inline"|"general", path?, line?, side?, body, createdAt }
 */
function draftsPath() {
  return path.join(app.getPath("userData"), "drafts.json");
}

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(draftsPath(), "utf8"));
  } catch {
    return {};
  }
}

function listFor(key) {
  return loadAll()[key] || [];
}

function saveFor(key, items) {
  const all = loadAll();
  if (items.length) all[key] = items;
  else delete all[key];
  fs.mkdirSync(path.dirname(draftsPath()), { recursive: true });
  fs.writeFileSync(draftsPath(), JSON.stringify(all, null, 2), { mode: 0o600 });
  return items;
}

module.exports = { listFor, saveFor };
