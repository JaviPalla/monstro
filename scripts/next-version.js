#!/usr/bin/env node
"use strict";

/**
 * Siguiente versión a partir de los commits (conventional commits), para auto-release.yml.
 *
 * Uso:  git log <ultimo-tag>..HEAD --format='%s%n%b' | node scripts/next-version.js <version-actual>
 * Sale: "<bump> <version>" (p.ej. "minor 0.4.0"), o nada y código 0 si no hay que publicar.
 *
 * Vive aquí y no incrustado en el YAML para poder probarlo: una regex mal puesta publicaría una
 * versión con el número equivocado sin que nada falle. Ver scripts/test-next-version.js.
 */

// Un `!` antes de los dos puntos (feat!:, fix(api)!:) o un footer BREAKING CHANGE = major.
const BREAKING = /^[a-z]+(\(.+\))?!:|^BREAKING CHANGE:/m;
const FEAT = /^feat(\(.+\))?:/m;
const FIX = /^(fix|perf)(\(.+\))?:/m;

/** @returns {{bump: "major"|"minor"|"patch", version: string} | null} null = no publicar */
function nextVersion(currentVersion, log) {
  const bump = BREAKING.test(log) ? "major" : FEAT.test(log) ? "minor" : FIX.test(log) ? "patch" : null;
  // docs/chore/ci/style/refactor/test no publican: no cambian lo que el usuario se instala.
  if (!bump) return null;

  const [major, minor, patch] = String(currentVersion || "0.0.0").split(".").map(Number);
  if ([major, minor, patch].some(Number.isNaN)) throw new Error(`Versión actual no válida: ${currentVersion}`);

  const next =
    bump === "major" ? [major + 1, 0, 0] : bump === "minor" ? [major, minor + 1, 0] : [major, minor, patch + 1];
  return { bump, version: next.join(".") };
}

module.exports = { nextVersion };

if (require.main === module) {
  const current = process.argv[2];
  const log = require("fs").readFileSync(0, "utf8");
  const result = nextVersion(current, log);
  if (result) console.log(`${result.bump} ${result.version}`);
}
