#!/usr/bin/env node
"use strict";

/**
 * Descripción de la release a partir de los commits (conventional commits), para release.yml.
 *
 * Uso:  git log <tag-anterior>..<tag> --format='%s%n%b%x00' | node scripts/release-notes.js
 * Sale: markdown con lo que cambia respecto a la versión anterior, agrupado por tipo.
 *
 * Mismo criterio que next-version.js: solo aparece lo que cambia lo que el usuario se instala
 * (feat/fix/perf y los breaking). docs/chore/ci/refactor/test/style y los merges se quedan fuera —
 * si publicara todo, la descripción sería el `git log` crudo y nadie la leería.
 *
 * Vive aquí y no incrustado en el YAML para poder probarlo. Ver scripts/test-release-notes.js.
 */

// El commit se parte por \0 (--format='%s%n%b%x00'): cabecera en la primera línea, cuerpo el resto.
// La regex es GLOBAL a propósito: en este repo hay cabeceras con VARIOS conventional commits
// pegados en una sola línea ("feat(releases): … feat(tests): … fix(ipc): …"). Cortando por cada
// tipo salen cuatro entradas legibles en vez de un párrafo ilegible.
const ENTRY = /(feat|fix|perf)(?:\(([^)]+)\))?(!)?:\s+/g;
const BREAKING_FOOTER = /^BREAKING CHANGE:/m;

const SECTIONS = [
  { key: "breaking", title: "### ⚠️ Cambios importantes" },
  { key: "feat", title: "### ✨ Novedades" },
  { key: "fix", title: "### 🐛 Arreglos y mejoras" },
];

const EMPTY = "Cambios internos y de mantenimiento, sin novedades visibles.";

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @returns {string} markdown para el cuerpo de la release (nunca vacío) */
function releaseNotes(log) {
  const groups = { breaking: [], feat: [], fix: [] };
  for (const chunk of String(log || "").split("\0")) {
    const header = chunk.trim().split("\n")[0].trim();
    const found = [...header.matchAll(ENTRY)];
    // Sin tipo, o con el tipo a media línea ("Merge branch … fix: x"): no es un commit convencional.
    // Fuera también merges y chore/docs/ci/refactor/test: no cambian lo que el usuario se instala.
    if (!found.length || found[0].index !== 0) continue;
    // Un BREAKING CHANGE en el cuerpo no dice a cuál de las entradas pegadas se refiere: marcarlas
    // todas es lo conservador — esconder un cambio que rompe es peor que señalar de más.
    const breakingBody = BREAKING_FOOTER.test(chunk);
    found.forEach((match, i) => {
      const [, type, scope, bang] = match;
      const text = header.slice(match.index + match[0].length, found[i + 1]?.index ?? header.length).trim();
      if (!text) return;
      // Un breaking va SOLO en su sección: repetirlo abajo diluiría justo lo que hay que mirar.
      const key = bang || breakingBody ? "breaking" : type === "feat" ? "feat" : "fix";
      const line = `- ${scope ? `**${scope}**: ` : ""}${capitalize(text)}`;
      if (!groups[key].includes(line)) groups[key].push(line); // los cherry-picks duplican el subject
    });
  }

  const blocks = SECTIONS.filter((s) => groups[s.key].length).map((s) => `${s.title}\n${groups[s.key].join("\n")}`);
  return blocks.length ? blocks.join("\n\n") : EMPTY;
}

module.exports = { releaseNotes };

if (require.main === module) {
  console.log(releaseNotes(require("fs").readFileSync(0, "utf8")));
}
