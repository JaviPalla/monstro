#!/usr/bin/env node
"use strict";

/**
 * Check de `nextVersion`: decide qué número lleva cada release automática. Si se equivoca, publica
 * una versión mal numerada sin que nada falle — el fallo silencioso es el que importa aquí.
 * `node scripts/test-next-version.js`
 */

const assert = require("assert");
const { nextVersion } = require("./next-version");

// feat → minor, y el patch se resetea.
assert.deepStrictEqual(nextVersion("0.3.1", "feat(env): nueva vista"), { bump: "minor", version: "0.4.0" });

// fix y perf → patch.
assert.deepStrictEqual(nextVersion("0.3.1", "fix(ci): typo"), { bump: "patch", version: "0.3.2" });
assert.deepStrictEqual(nextVersion("0.3.1", "perf: menos llamadas"), { bump: "patch", version: "0.3.2" });

// `!` o el footer BREAKING CHANGE → major, y minor y patch se resetean.
assert.deepStrictEqual(nextVersion("0.3.1", "feat!: cambia el config"), { bump: "major", version: "1.0.0" });
assert.deepStrictEqual(nextVersion("0.3.1", "fix(api)!: quita el endpoint"), { bump: "major", version: "1.0.0" });
assert.deepStrictEqual(
  nextVersion("0.3.1", "feat: algo\n\nBREAKING CHANGE: ya no vale el config viejo"),
  { bump: "major", version: "1.0.0" },
);

// LO IMPORTANTE: lo que no cambia lo que el usuario se instala NO publica nada.
assert.strictEqual(nextVersion("0.3.1", "docs: readme"), null);
assert.strictEqual(nextVersion("0.3.1", "chore(release): v0.3.1"), null);
assert.strictEqual(nextVersion("0.3.1", "ci: cachea npm\nrefactor: extrae función\ntest: añade caso"), null);

// El bump más alto gana aunque venga el último (se mira todo el rango, no solo el primero).
assert.deepStrictEqual(nextVersion("1.2.3", "docs: x\nfix: y\nfeat: z"), { bump: "minor", version: "1.3.0" });
assert.deepStrictEqual(nextVersion("1.2.3", "fix: y\nfeat!: z"), { bump: "major", version: "2.0.0" });

// Sin tags previos: se arranca desde 0.0.0.
assert.deepStrictEqual(nextVersion("", "feat: primera"), { bump: "minor", version: "0.1.0" });

// "fixup", "feature" y demás NO son tipos válidos: no deben colar como fix/feat.
assert.strictEqual(nextVersion("0.3.1", "fixup: algo"), null);
assert.strictEqual(nextVersion("0.3.1", "feature: algo"), null);

assert.throws(() => nextVersion("no-es-semver", "feat: x"), /no válida/);

console.log("✓ next version ok");
