#!/usr/bin/env node
"use strict";

/**
 * Caza globals huérfanos en los handlers de `src/ipc/*.js`.
 *
 * El split de main.js en módulos por dominio se llevó los handlers pero dejó atrás alguna constante
 * declarada arriba del fichero original: `releases:create` petaba con `ReferenceError: BRANCH_RE is
 * not defined` y no se veía hasta pulsar el botón, porque un identificador libre solo revienta al
 * EJECUTAR la línea, no al cargar el módulo. `node --check` no lo ve, y aquí no hay linter.
 *
 * Así que ejecutamos de verdad cada handler. Todo lo que un handler pueda tocar (electron, provider,
 * config, local, ai…) está stubbeado con un proxy inerte, así que no hay red ni escrituras: el
 * handler recorre sus validaciones y muere en el primer stub. Solo nos importa CÓMO muere — un
 * ReferenceError es un bug real; cualquier otro error es el stub haciendo su trabajo.
 *
 * `node scripts/test-ipc-handlers.js`
 */

const Module = require("module");
const path = require("path");
const fs = require("fs");

// Proxy inerte y encadenable: llamarlo, construirlo o leerle cualquier propiedad devuelve otro
// igual, y en contexto de string vale "". Así un handler puede hacer `await gh().releaseDefaults()`
// y desestructurar el resultado sin petar por algo que no sea el bug que buscamos.
const inert = () =>
  new Proxy(function () {}, {
    get(_t, k) {
      if (k === "then") return undefined; // que `await` no se cuelgue buscando un thenable
      if (k === Symbol.toPrimitive || k === "toString") return () => "";
      if (typeof k === "symbol") return undefined;
      return inert();
    },
    apply: () => inert(),
    construct: () => inert(),
  });

// Los handlers registrados, en orden: [canal, fn].
const handlers = [];

const electronStub = {
  ipcMain: { handle: (channel, fn) => handlers.push([channel, fn]), on: () => {}, removeHandler: () => {} },
  app: { getPath: () => path.join(__dirname, "..", ".selftest-tmp"), getVersion: () => "0.0.0", on: () => {}, quit: () => {} },
  BrowserWindow: class {},
  Notification: class {},
  dialog: inert(),
  shell: inert(),
  nativeTheme: inert(),
};

// Todo lo que src/ipc/* puede requerir de dentro del proyecto. Se stubbea para que ningún handler
// llegue a GitLab ni al disco.
const STUBBED = new Set([
  "electron",
  "../agents",
  "../ai",
  "../config",
  "../drafts",
  "../health",
  "../local",
  "../localhistory",
  "../provider",
  "../updater",
]);

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (STUBBED.has(request)) return inert();
  return realLoad.call(this, request, parent, isMain);
};

const ctx = { win: null, SELFTEST: true, localRootGuard: inert(), prepareLocalBranch: inert(), planMarkdown: inert() };

const ipcDir = path.join(__dirname, "..", "src", "ipc");
for (const file of fs.readdirSync(ipcDir).filter((f) => f.endsWith(".js")).sort()) {
  require(path.join(ipcDir, file)).register(ctx);
}

// Un payload con TODAS las claves que usan los handlers, cada una con un valor que pasa las
// validaciones de formato. Es lo que hace que la ejecución llegue hasta el fondo del handler en vez
// de morir en el primer `throw` de validación — el BRANCH_RE que faltaba vivía justo detrás de uno.
const PAYLOAD = {
  version: "072026",
  sourceBranch: "development",
  projects: [{ id: "grupo/proyecto", name: "proyecto" }],
  projectId: "grupo/proyecto",
  variant: "both",
  base: "2026.07",
  ref: "rb/072026",
  tag: "2026.07.0",
  branch: "development",
  jobId: "1",
  milestones: ["2026.07"],
  description: "d",
  name: "n",
  repo: "grupo/proyecto",
  number: 1,
  url: "https://example.invalid",
  path: "grupo/proyecto",
  body: "b",
  title: "t",
  id: "1",
};

const bugs = [];
let ran = 0;

(async () => {
  for (const [channel, fn] of handlers) {
    // Dos formas: el payload rico (llega al fondo) y sin argumentos (dispara los caminos de guarda).
    for (const arg of [PAYLOAD, undefined]) {
      ran++;
      try {
        await fn({}, arg);
      } catch (err) {
        if (err instanceof ReferenceError) bugs.push(`${channel}: ${err.message}`);
      }
    }
  }

  console.log(`${handlers.length} handlers, ${ran} invocaciones.`);
  if (bugs.length) {
    console.error("\nGlobals huérfanos:");
    for (const b of [...new Set(bugs)]) console.error(`  ✗ ${b}`);
    process.exit(1);
  }
  console.log("Sin ReferenceError. OK.");
})();
