#!/usr/bin/env node
"use strict";

/**
 * Check mínimo de `mergeSummaryBlock`: lo que escribe Monstro en la descripción del milestone
 * tiene que reemplazar SOLO su propio bloque y no pisar lo que haya escrito una persona.
 * `node scripts/test-summary-block.js`
 */

const assert = require("assert");
const { mergeSummaryBlock } = require("../src/gitlab");

const START = "<!-- monstro:summary:start -->";
const END = "<!-- monstro:summary:end -->";

// Descripción vacía: solo el bloque.
assert.strictEqual(mergeSummaryBlock("", "# Novedades"), `${START}\n# Novedades\n${END}\n`);

// Descripción ajena sin bloque: se conserva y el bloque se añade al final.
assert.strictEqual(
  mergeSummaryBlock("Objetivos del trimestre", "# Novedades"),
  `Objetivos del trimestre\n\n${START}\n# Novedades\n${END}\n`,
);

// Con bloque previo: se reemplaza el contenido y sobrevive el texto de antes Y el de después.
const prev = `Antes\n\n${START}\n# Viejo\n${END}\n\nDespués`;
const next = mergeSummaryBlock(prev, "# Nuevo");
assert.ok(next.startsWith("Antes"), "se pierde el texto previo al bloque");
assert.ok(next.endsWith("Después"), "se pierde el texto posterior al bloque");
assert.ok(next.includes("# Nuevo") && !next.includes("# Viejo"), "no se reemplazó el contenido del bloque");
assert.strictEqual(next.split(START).length - 1, 1, "el bloque se duplicó");

// Idempotente: regenerar dos veces el mismo contenido no acumula bloques.
assert.strictEqual(mergeSummaryBlock(next, "# Nuevo"), next);

// Marcadores corruptos (END antes que START): se trata como si no hubiera bloque, no se rompe.
assert.ok(mergeSummaryBlock(`${END} suelto ${START}`, "# X").includes("# X"));

console.log("ok — mergeSummaryBlock");
