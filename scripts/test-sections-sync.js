#!/usr/bin/env node
"use strict";

/**
 * Las claves de apartado viven en DOS sitios y tienen que coincidir:
 *
 *   - `MENU_SECTIONS` (renderer/app/core.js) — el catálogo que pinta el menú y los toggles.
 *   - `SECTION_KEYS`  (src/ipc/config.js)    — el enum cerrado con el que `config:set` filtra.
 *
 * Añadir una sección solo en el renderer NO da error: el filtro del main la tira en silencio, se
 * guarda un `sections` sin ella y el usuario marca la casilla una y otra vez sin que pase nada.
 * Eso costó un rato con la sección `propuestas`.
 *
 * `node scripts/test-sections-sync.js`
 */

const fs = require("fs");
const path = require("path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

// MENU_SECTIONS = { prs: {...}, historial: {...} } → las claves al principio de cada línea.
function menuSectionKeys() {
  const src = read("renderer", "app", "core.js");
  const block = src.match(/const MENU_SECTIONS = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error("No se encontró MENU_SECTIONS en renderer/app/core.js");
  return [...block[1].matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
}

function sectionKeys() {
  const src = read("src", "ipc", "config.js");
  const line = src.match(/const SECTION_KEYS = \[([^\]]*)\]/);
  if (!line) throw new Error("No se encontró SECTION_KEYS en src/ipc/config.js");
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const menu = menuSectionKeys();
const allowed = sectionKeys();
const missing = menu.filter((k) => !allowed.includes(k));
const extra = allowed.filter((k) => !menu.includes(k));

if (missing.length || extra.length) {
  if (missing.length) console.error(`✗ En MENU_SECTIONS pero NO en SECTION_KEYS (se descartarían al guardar): ${missing.join(", ")}`);
  if (extra.length) console.error(`✗ En SECTION_KEYS pero NO en MENU_SECTIONS (sobran): ${extra.join(", ")}`);
  process.exit(1);
}

console.log(`✓ secciones sincronizadas (${menu.length}): ${menu.join(", ")}`);
