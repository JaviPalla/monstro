#!/usr/bin/env node
"use strict";

/**
 * Check de `releaseNotes`: lo que se publica en la descripción de cada release de GitHub. Si se
 * equivoca no falla nada — simplemente sale una descripción vacía o con el `git log` crudo, y de
 * eso no se entera nadie hasta que un usuario abre la release.
 * `node scripts/test-release-notes.js`
 */

const assert = require("assert");
const { releaseNotes } = require("./release-notes");

const commit = (...chunks) => chunks.join("\0");

// Agrupa por tipo, en el orden importante → menos importante.
assert.strictEqual(
  releaseNotes(commit("fix: corrige el badge del dock", "feat(entornos): añade la matriz de salud")),
  "### ✨ Novedades\n- **entornos**: Añade la matriz de salud\n\n### 🐛 Arreglos y mejoras\n- Corrige el badge del dock",
);

// perf entra con los arreglos (igual que en next-version.js, donde también es patch).
assert.match(releaseNotes(commit("perf: menos llamadas a la API")), /### 🐛 Arreglos y mejoras\n- Menos llamadas/);

// Un breaking va SOLO arriba, no repetido en su sección de tipo. Da igual si viene por `!`…
assert.strictEqual(
  releaseNotes(commit("feat!: cambia el formato del config")),
  "### ⚠️ Cambios importantes\n- Cambia el formato del config",
);
// …o por el footer.
assert.strictEqual(
  releaseNotes(commit("fix(api): quita el endpoint viejo\n\nBREAKING CHANGE: ya no vale el config anterior")),
  "### ⚠️ Cambios importantes\n- **api**: Quita el endpoint viejo",
);

// LO IMPORTANTE: el ruido no se publica. Merges y tipos que no cambian lo que el usuario instala.
const noise = commit(
  "chore(release): v0.12.0 [skip ci]",
  "Merge branch 'main' of https://github.com/JaviPalla/monstro",
  "docs: actualiza el readme",
  "ci: cachea npm",
  "refactor: extrae función",
  "test: añade caso",
);
assert.match(releaseNotes(noise), /^Cambios internos/);
assert.strictEqual(releaseNotes(""), "Cambios internos y de mantenimiento, sin novedades visibles.");

// Pero el ruido no debe tapar lo que sí importa cuando vienen mezclados.
assert.strictEqual(
  releaseNotes(commit("chore: limpia", "feat: nueva vista de releases", "Merge branch 'main'")),
  "### ✨ Novedades\n- Nueva vista de releases",
);

// "fixup"/"feature" no son tipos válidos: no deben colar (mismo criterio que next-version.js).
assert.match(releaseNotes(commit("fixup: algo", "feature: algo")), /^Cambios internos/);

// Un cherry-pick repite el mismo subject: una sola línea, no dos.
assert.strictEqual(
  releaseNotes(commit("fix: corrige el rebase", "fix: corrige el rebase")),
  "### 🐛 Arreglos y mejoras\n- Corrige el rebase",
);

// El "(#12)" del final se conserva: GitHub lo convierte en enlace a la PR.
assert.match(releaseNotes(commit("feat: exporta a CSV (#12)")), /- Exporta a CSV \(#12\)$/);

// CASO REAL (509de8b): cuatro conventional commits pegados en la MISMA línea de asunto. Sin
// partirlos sale un párrafo ilegible con todo dentro de la primera entrada.
assert.strictEqual(
  releaseNotes(
    commit(
      "feat(releases): mejora el pipeline feat(tests): amplía los tests de IPC " +
        "fix(ipc): incluye prepareLocalBranch fix(ipc): añade el módulo shell",
    ),
  ),
  "### ✨ Novedades\n- **releases**: Mejora el pipeline\n- **tests**: Amplía los tests de IPC\n\n" +
    "### 🐛 Arreglos y mejoras\n- **ipc**: Incluye prepareLocalBranch\n- **ipc**: Añade el módulo shell",
);

// Pero un tipo a media línea NO parte nada: eso es prosa, no un commit convencional.
assert.match(releaseNotes(commit("Merge branch 'main' fix: algo")), /^Cambios internos/);

console.log("✓ release notes ok");
