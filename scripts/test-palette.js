"use strict";
/**
 * Guarda de la paleta de comandos (⌘P): renderer/app/palette.js.
 *
 * paletteEntries() es un árbol de guards (PR abierta o no, mía o de otro, abierta o mergeada,
 * apartados habilitados…) y esos guards deben seguir exactamente a los botones de renderDetail():
 * la paleta NUNCA puede ofrecer una acción que la UI tiene deshabilitada. Esto lo comprueba.
 *
 * Se ejecuta con `node scripts/test-palette.js`. El renderer son scripts clásicos en ámbito
 * global, así que basta evaluar el fichero en un contexto vm cuyas globales desconocidas
 * (enterMilestones, refresh, …) resuelven a no-ops: aquí solo se mira QUÉ entradas salen.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "palette.js"), "utf8");

/** Contexto con lo mínimo real; cualquier otra global es una función no-op. */
function evaluatePalette({ pr = null, drafts = [], sections = () => true, repos = ["g/a"], approvedByMe = false, query = "", openPrs = null } = {}) {
  const noop = () => {};
  const globals = {
    state: {
      detailPR: pr,
      detailTab: "conv",
      drafts,
      openPrs: openPrs || [{ number: 7, title: "Algo", headRefName: "feat/x", baseRefName: "main" }],
      me: { login: "yo" },
      config: { repos, uiTheme: "default" },
      aiGenerating: null,
    },
    t: (es, params) => (params ? Object.keys(params).reduce((acc, k) => acc.split(`{${k}}`).join(params[k]), es) : es),
    sectionEnabled: sections,
    canMerge: (p) => p.state === "OPEN",
    myApprovedReview: () => (approvedByMe ? { databaseId: 1 } : null),
    currentLang: () => "es",
    providerName: () => "GitLab",
    ALL_REPOS: "__all__",
    window: { monstro: { openExternal: noop, setConfig: noop, checkUpdates: noop } },
    console,
  };
  const context = vm.createContext(
    new Proxy(globals, {
      has: () => true, // todo identificador "existe": las globales que no stubeo caen en get
      get: (target, key) => (key in target ? target[key] : noop),
    }),
  );
  vm.runInContext(SOURCE, context);
  context.__query = query;
  return vm.runInContext("paletteEntries(__query)", context);
}

const labels = (entries) => entries.map((e) => e.label);
const openPR = { number: 42, title: "X", state: "OPEN", author: { login: "otro" }, isDraft: false, headRefName: "f", baseRefName: "main", url: "https://x/42" };

// 1. Toda entrada es accionable: sin esto un Enter en la paleta revienta en silencio.
const base = evaluatePalette();
assert.ok(base.length > 20, `esperaba un índice poblado, hay ${base.length}`);
for (const e of base) {
  assert.ok(typeof e.run === "function", `entrada sin run(): ${e.label}`);
  assert.ok(e.group && e.label, `entrada sin group/label: ${JSON.stringify(e)}`);
  assert.ok(typeof e.hint === "string", `hint no es texto en: ${e.label}`);
}

// 2. Sin detalle abierto no hay acciones de PR (llamarlas explotaría con state.detailPR = null).
assert.ok(!base.some((e) => e.group.startsWith("PR #")), "sin detalle abierto no debe haber grupo de PR");

// 3. PR abierta de otra persona: se puede aprobar, mergear, rebasar y revisar con IA.
const other = labels(evaluatePalette({ pr: openPR }));
for (const expected of ["Aprobar", "Merge (merge commit)", "Update branch (rebase)", "Review con IA", "Abrir en el navegador"]) {
  assert.ok(other.includes(expected), `falta "${expected}" en una PR abierta ajena`);
}
assert.ok(!other.includes("Quitar aprobación"), "sin review aprobada mía no se ofrece quitarla");
assert.ok(!other.includes("Revertir"), "una PR abierta no se revierte");

// 4. Ya aprobada por mí: se ofrece quitar la aprobación, no volver a aprobar.
const approved = labels(evaluatePalette({ pr: openPR, approvedByMe: true }));
assert.ok(approved.includes("Quitar aprobación"), "falta quitar aprobación");
assert.ok(!approved.includes("Aprobar"), "no se puede aprobar dos veces");

// 5. PR propia: nunca aprobar la tuya (mismo guard que el botón), sí alternar borrador.
const mine = labels(evaluatePalette({ pr: { ...openPR, author: { login: "yo" } } }));
assert.ok(!mine.includes("Aprobar"), "no puedes aprobar tu propia PR");
assert.ok(mine.includes("Convertir a borrador"), "falta el toggle de borrador en una PR propia");

// 6. PR mergeada: se revierte, no se rebasa/mergea/aprueba.
const merged = labels(evaluatePalette({ pr: { ...openPR, state: "MERGED" } }));
assert.ok(merged.includes("Revertir"), "una PR mergeada debe poder revertirse");
for (const forbidden of ["Update branch (rebase)", "Merge (merge commit)", "Aprobar", "Review con IA"]) {
  assert.ok(!merged.includes(forbidden), `"${forbidden}" no aplica a una PR mergeada`);
}

// 7. Los borradores locales solo aparecen si los hay.
assert.ok(!labels(evaluatePalette({ pr: openPR })).includes("Publicar borradores"), "sin borradores no se ofrece publicar");
assert.ok(labels(evaluatePalette({ pr: openPR, drafts: [{ id: 1 }] })).includes("Publicar borradores"), "con borradores debe ofrecerse publicar");

// 8. Apartados deshabilitados en Ajustes: fuera de la paleta también (es el mismo whitelist).
const hidden = evaluatePalette({ sections: () => false });
assert.strictEqual(hidden.filter((e) => e.group === "Ir a").length, 0, "un apartado oculto no debe ser navegable desde la paleta");
assert.ok(evaluatePalette().filter((e) => e.group === "Ir a").length > 10, "con todo habilitado deben salir los apartados");

// 9. "Todos los repos" solo tiene sentido con más de uno.
assert.ok(!labels(evaluatePalette({ repos: ["g/a"] })).some((l) => l.includes("Todos los repos")), "con un repo no hay vista agregada");
assert.ok(labels(evaluatePalette({ repos: ["g/a", "g/b"] })).some((l) => l.includes("Todos los repos")), "con varios repos falta la vista agregada");

// 10. Un texto que matchea decenas de PRs no puede enterrar las acciones: las PRs van capadas.
const noisy = Array.from({ length: 50 }, (_, i) => ({ number: i, title: "Resolve: ir a por ello", headRefName: "f", baseRefName: "main" }));
const flooded = evaluatePalette({ openPrs: noisy, query: "ir" });
const prCount = flooded.filter((e) => e.group === "Pull requests").length;
assert.ok(prCount <= 6, `las PRs deben ir capadas, salen ${prCount}`);
assert.ok(flooded.some((e) => e.group === "Ir a"), "las acciones deben sobrevivir a una query ruidosa");

// 11. El filtro mira grupo + label + hint (buscar por grupo es la vía sin saber el nombre exacto).
assert.ok(evaluatePalette({ query: "repositorio" }).every((e) => e.group === "Repositorio"), "buscar por grupo debe acotar al grupo");
assert.strictEqual(evaluatePalette({ query: "zzzz-no-existe" }).length, 0, "una query imposible no devuelve nada");

console.log(`✓ paleta de comandos: ${base.length} entradas, guards de PR/apartados/repos y filtro correctos`);
