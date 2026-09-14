"use strict";
/**
 * Guarda del renderer de markdown de la ficha de sesiones: renderer/app/markdown.js.
 *
 * El plan y el último mensaje de Claude salen de un transcript (texto que no controlamos) y se pintan
 * como HTML: el renderer escapa TODO primero y solo enlaza https://. Aquí se comprueba que ningún caso
 * típico de XSS abre una etiqueta o se sale de un atributo, y que el formato básico sale bien.
 *
 * `node scripts/test-markdown.js`. El renderer son scripts clásicos en ámbito global: se evalúa el
 * fichero en un contexto vm vacío (no usa el DOM), con icons.js antes, como en index.html.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const context = vm.createContext({});
for (const file of ["icons.js", "markdown.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "renderer", "app", file), "utf8"), context);
}
const md = (text) => context.renderMarkdown(text);

// Todo <a> que salga tiene que ser exactamente el nuestro: href https sin comillas dentro, y nada más.
const SAFE_A = /^<a href="https:\/\/[^"<>\s]*" target="_blank" rel="noopener noreferrer">$/;
function assertSafe(html, label) {
  for (const tag of html.match(/<a\b[^>]*>/g) || []) assert.match(tag, SAFE_A, `${label}: enlace inseguro ${tag}`);
  assert.ok(!/<(script|img|iframe|svg|style|object|embed)\b/i.test(html), `${label}: etiqueta peligrosa en ${html}`);
  assert.ok(!/<[a-z]+[^>]*\son\w+=/i.test(html), `${label}: atributo on* en ${html}`);
  assert.ok(!/href="(?!https:\/\/)/.test(html), `${label}: href que no es https en ${html}`);
}

// 1. XSS: etiquetas crudas, manejadores, javascript:/data:, comillas que intentan salir del href.
const attacks = {
  script: "<script>alert(1)</script>",
  img: '<img src=x onerror="alert(1)">',
  inlineHtml: "hola <b onclick=alert(1)>negrita</b>",
  jsLink: "[pulsa](javascript:alert(1))",
  dataLink: "[pulsa](data:text/html,<script>alert(1)</script>)",
  quoteLink: '[x](https://ok.example/"onmouseover="alert(1))',
  quoteAuto: 'mira https://ok.example/"onclick="alert(1) ya',
  httpLink: "[inseguro](http://ok.example/a)",
  inCode: "`<img src=x onerror=alert(1)>`",
  inFence: "```\n<script>alert(1)</script>\n```",
  inTable: "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:1) |",
  inList: "- <script>x</script>\n  - [y](javascript:1)",
  inQuote: "> <iframe src=https://evil.example></iframe>",
  heading: "# <svg onload=alert(1)>",
  nul: "a\u00000\u0000b `c`",
};
for (const [label, text] of Object.entries(attacks)) assertSafe(md(text), label);
assert.ok(md(attacks.script).includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "el HTML crudo se enseña escapado, no se pierde");
assert.ok(!md(attacks.jsLink).includes("<a"), "javascript: no se enlaza");
assert.ok(!md(attacks.httpLink).includes("<a"), "solo se enlaza https://");
assert.ok(md(attacks.quoteLink).includes('<a href="https://ok.example/"'), "la comilla corta la URL, no el atributo");

// 2. Formato: bloques.
assert.strictEqual(md("# Plan\n\nTexto"), "<h1>Plan</h1><p>Texto</p>");
assert.strictEqual(md("### Paso 2 ###"), "<h3>Paso 2</h3>");
assert.strictEqual(md("uno\ndos\n\ntres"), "<p>uno<br>dos</p><p>tres</p>");
assert.strictEqual(md("---"), "<hr>");
assert.strictEqual(md("> cita\n> **dos**"), "<blockquote><p>cita<br><strong>dos</strong></p></blockquote>");
assert.strictEqual(md("```js\nconst a = 1 < 2 && **no**;\n```"), "<pre><code>const a = 1 &lt; 2 &amp;&amp; **no**;</code></pre>");

// Listas: ordenada con número de inicio, un nivel anidado, tareas y continuación de línea.
assert.strictEqual(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
assert.strictEqual(md("3. tres\n4. cuatro"), '<ol start="3"><li>tres</li><li>cuatro</li></ol>');
assert.strictEqual(
  md("1. Primero\n   - sub a\n   - sub b\n2. Segundo"),
  "<ol><li>Primero<ul><li>sub a</li><li>sub b</li></ul></li><li>Segundo</li></ol>",
);
assert.strictEqual(md("- [x] hecho\n- [ ] falta"), `<ul><li class="md-task"><span class="md-check">${context.icon("square-check")}</span> hecho</li><li class="md-task"><span class="md-check">${context.icon("square")}</span> falta</li></ul>`);
assert.strictEqual(md("- punto\n  que sigue"), "<ul><li>punto<br>que sigue</li></ul>");
assert.strictEqual(md("- a\n\n- b\n\nfin"), "<ul><li>a</li><li>b</li></ul><p>fin</p>");

// Tabla con alineación.
assert.strictEqual(
  md("| Fichero | Líneas |\n|:--|--:|\n| a.js | 12 |"),
  '<div class="md-table"><table><thead><tr><th>Fichero</th><th class="md-right">Líneas</th></tr></thead><tbody><tr><td>a.js</td><td class="md-right">12</td></tr></tbody></table></div>',
);

// 3. Formato: en línea.
assert.strictEqual(md("**negrita** y *cursiva* y ~~tachado~~"), "<p><strong>negrita</strong> y <em>cursiva</em> y <del>tachado</del></p>");
assert.strictEqual(md("usa `a_b_c` y foo_bar_baz"), "<p>usa <code>a_b_c</code> y foo_bar_baz</p>", "snake_case no es cursiva");
assert.strictEqual(md("`**no**`"), "<p><code>**no**</code></p>", "dentro del código no hay formato");
assert.strictEqual(md("[MR !12](https://g.example/p/-/merge_requests/12)"), '<p><a href="https://g.example/p/-/merge_requests/12" target="_blank" rel="noopener noreferrer">MR !12</a></p>');
assert.strictEqual(md("ver https://g.example/a?x=1&y=2."), '<p>ver <a href="https://g.example/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https://g.example/a?x=1&amp;y=2</a>.</p>');
assert.strictEqual(md(""), "");
assert.strictEqual(md(null), "");

console.log(`✓ markdown: ${Object.keys(attacks).length} casos XSS y el formato básico correctos`);
