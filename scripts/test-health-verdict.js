#!/usr/bin/env node
"use strict";

/**
 * Check mínimo de `healthVerdict`: la sonda de entornos NO puede dar por sano un 200 que solo trae
 * el index.html de una SPA. Es el único fallo que importa de verdad — pintaría verde un entorno con
 * el backend muerto.
 * `node scripts/test-health-verdict.js`
 */

const assert = require("assert");
const { healthVerdict } = require("../src/health");

// Una API devolviendo JSON: prueba positiva → sano.
assert.strictEqual(healthVerdict({ ok: true, httpStatus: 200, contentType: "application/json" }).status, "up");

// LA TRAMPA: 200 con HTML y sin texto esperado. La SPA responde esto en cualquier ruta, así que no
// demuestra nada → "no verificable", nunca "up".
assert.strictEqual(healthVerdict({ ok: true, httpStatus: 200, contentType: "text/html; charset=utf-8" }).status, "unknown");

// Con texto esperado configurado, el HTML sí se puede verificar en los dos sentidos.
assert.strictEqual(
  healthVerdict({ ok: true, httpStatus: 200, contentType: "text/html", expect: "OK", bodyMatched: true }).status,
  "up",
);
assert.strictEqual(
  healthVerdict({ ok: true, httpStatus: 200, contentType: "text/html", expect: "OK", bodyMatched: false }).status,
  "down",
);

// Errores del servidor: caído, sin matices.
assert.strictEqual(healthVerdict({ ok: false, httpStatus: 502 }).status, "down");
assert.strictEqual(healthVerdict({ ok: false, httpStatus: 404 }).note, "HTTP 404");

console.log("✓ health verdict ok");
