"use strict";

/*
 * Guarda de los iconos de Lucide (renderer/app/icons.js): cada icon("…") del renderer existe en LUCIDE y en
 * LUCIDE no sobra ninguno. Un nombre cuenta como usado si sale entre comillas en algún fichero del renderer,
 * así que los que llegan por un mapa (TOAST_ICON, LINK_ICON…) también cuentan.
 * ponytail: el nombre dentro de un mapa no se valida contra LUCIDE (icon() lo pintaría vacío); se ve al abrir la vista.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = path.join(__dirname, "..", "renderer", "app");
const ctx = {};
vm.runInNewContext(`${fs.readFileSync(path.join(APP, "icons.js"), "utf8")}\nthis.LUCIDE = LUCIDE; this.icon = icon;`, ctx);
const names = new Set(Object.keys(ctx.LUCIDE));
const sources = fs.readdirSync(APP)
  .filter((f) => f.endsWith(".js") && f !== "icons.js")
  .map((f) => fs.readFileSync(path.join(APP, f), "utf8"))
  .join("\n");

const called = [...sources.matchAll(/\bicon\(\s*"([^"]+)"/g)].map((m) => m[1]);
const missing = [...new Set(called)].filter((name) => !names.has(name));
assert.deepStrictEqual(missing, [], `icon() con nombres que no están en LUCIDE: ${missing.join(", ")}`);

const quoted = new Set([...sources.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
const unused = [...names].filter((name) => !quoted.has(name));
assert.deepStrictEqual(unused, [], `iconos de LUCIDE que no usa nadie: ${unused.join(", ")}`);

assert.ok(ctx.icon("x").startsWith('<svg class="lucide lucide-x"'));
assert.strictEqual(ctx.icon("no-existe"), "");
console.log(`✓ iconos: ${called.length} icon("…") literales, ${names.size} iconos de Lucide, ninguno roto ni de sobra`);
