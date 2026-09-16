"use strict";
/**
 * Guarda de src/gitlab/core.js: renderGitlabMarkdown() + resolveUploadPaths() (el markdown crudo
 * de GitLab -> HTML seguro para descripciones/comentarios de MR). Mismo patrón que
 * scripts/test-markdown.js (escapar TODO primero, transformar después) pero esta versión SÍ admite
 * <img>: el cuerpo es de tu propio GitLab, no un transcript con texto ajeno (ver el comentario en
 * core.js). Solo prueba las funciones puras (sin config/Electron): `node scripts/test-gitlab-markdown.js`.
 */
const assert = require("assert");
const { renderGitlabMarkdown: md, resolveUploadPaths } = require("../src/gitlab/core");

// Todo <a>/<img> que salga tiene que ser exactamente el nuestro: src/href https sin comillas dentro.
const SAFE_A = /^<a href="https:\/\/[^"<>\s]*" target="_blank" rel="noopener noreferrer">$/;
const SAFE_IMG = /^<img src="https:\/\/[^"<>\s]*" alt="[^"<>]*"( width="\d+")?( height="\d+")? loading="lazy">$/;
function assertSafe(html, label) {
  for (const tag of html.match(/<a\b[^>]*>/g) || []) assert.match(tag, SAFE_A, `${label}: enlace inseguro ${tag}`);
  for (const tag of html.match(/<img\b[^>]*>/g) || []) assert.match(tag, SAFE_IMG, `${label}: imagen insegura ${tag}`);
  assert.ok(!/<(script|iframe|svg|style|object|embed)\b/i.test(html), `${label}: etiqueta peligrosa en ${html}`);
  assert.ok(!/<[a-z]+[^>]*\son\w+=/i.test(html), `${label}: atributo on* en ${html}`);
  assert.ok(!/(href|src)="(?!https:\/\/)/.test(html), `${label}: href/src que no es https en ${html}`);
}

// 1. XSS: etiquetas crudas, manejadores, javascript:/data:, comillas que intentan salir del atributo.
const attacks = {
  script: "<script>alert(1)</script>",
  img: '<img src=x onerror="alert(1)">',
  inlineHtml: "hola <b onclick=alert(1)>negrita</b>",
  jsLink: "[pulsa](javascript:alert(1))",
  dataImage: "![x](data:text/html,<script>alert(1)</script>)",
  quoteLink: '[x](https://ok.example/"onmouseover="alert(1))',
  quoteImage: '![x](https://ok.example/i.png"onerror="alert(1))',
  httpLink: "[inseguro](http://ok.example/a)",
  httpImage: "![inseguro](http://ok.example/a.png)",
  inCode: "`<img src=x onerror=alert(1)>`",
  inFence: "```\n<script>alert(1)</script>\n```",
  heading: "# <svg onload=alert(1)>",
};
for (const [label, text] of Object.entries(attacks)) assertSafe(md(text), label);
assert.ok(md(attacks.script).includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "el HTML crudo se enseña escapado, no se pierde");
assert.ok(!md(attacks.jsLink).includes("<a"), "javascript: no se enlaza");
assert.ok(!md(attacks.dataImage).includes("<img"), "data: no se renderiza como imagen");
assert.ok(!md(attacks.httpLink).includes("<a"), "solo se enlaza https://");
assert.ok(!md(attacks.httpImage).includes("<img"), "solo se renderiza https://");

// 2. Imágenes y enlaces (el motivo de este fichero): la sintaxis de imagen no cae en el enlace.
assert.strictEqual(md("![captura](https://g.example/uploads/abc/shot.png)"), '<p><img src="https://g.example/uploads/abc/shot.png" alt="captura" loading="lazy"></p>');
assert.strictEqual(md("texto ![](https://g.example/i.png) y [MR !12](https://g.example/p/-/merge_requests/12)"), '<p>texto <img src="https://g.example/i.png" alt="" loading="lazy"> y <a href="https://g.example/p/-/merge_requests/12" target="_blank" rel="noopener noreferrer">MR !12</a></p>');

// 2b. GitLab añade el tamaño tras la imagen al pegar una captura: "![x](url){width=496 height=290}".
// Se consume el {...}, se traduce a atributos y no se cuela como texto suelto.
assert.strictEqual(
  md("![captura](https://g.example/uploads/a/shot.png){width=496 height=290}"),
  '<p><img src="https://g.example/uploads/a/shot.png" alt="captura" width="496" height="290" loading="lazy"></p>',
);
assert.strictEqual(
  md("![captura](https://g.example/uploads/a/shot.png){width=390}"),
  '<p><img src="https://g.example/uploads/a/shot.png" alt="captura" width="390" loading="lazy"></p>',
);
assertSafe(md("![x](https://g.example/i.png){width=496 height=290}"), "image-attrs");

// 3. Captura pegada en una nota (ruta relativa /uploads/...): se resuelve contra el proyecto ANTES
// de renderizar; sin repoFullName se deja tal cual (y por tanto no se enlaza: no es https).
assert.strictEqual(
  resolveUploadPaths("![x](/uploads/abc123/shot.png)", "https://gitlab.example.com", "grupo/proyecto"),
  "![x](https://gitlab.example.com/grupo/proyecto/uploads/abc123/shot.png)",
);
assert.strictEqual(resolveUploadPaths("![x](/uploads/abc123/shot.png)", "https://gitlab.example.com", null), "![x](/uploads/abc123/shot.png)");
assert.ok(!md("![x](/uploads/abc123/shot.png)").includes("<img"), "una ruta relativa sin resolver no se renderiza");

// 4. Formato básico.
assert.strictEqual(md("# Título\n\nTexto"), "<h1>Título</h1><p>Texto</p>");
assert.strictEqual(md("uno\ndos\n\ntres"), "<p>uno<br>dos</p><p>tres</p>");
assert.strictEqual(md("**negrita** y *cursiva* y ~~tachado~~ y `code`"), "<p><strong>negrita</strong> y <em>cursiva</em> y <del>tachado</del> y <code>code</code></p>");
assert.strictEqual(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
assert.strictEqual(md("1. uno\n2. dos"), "<ol><li>uno</li><li>dos</li></ol>");
assert.strictEqual(md("- [x] hecho\n- [ ] falta"), '<ul><li><input type="checkbox" disabled checked> hecho</li><li><input type="checkbox" disabled > falta</li></ul>');
assert.strictEqual(md("```js\nconst a = 1 < 2;\n```"), "<pre><code>const a = 1 &lt; 2;</code></pre>");
assert.strictEqual(md("> cita\n> **dos**"), "<blockquote><p>cita<br><strong>dos</strong></p></blockquote>");
assert.strictEqual(md(""), "");
assert.strictEqual(md(null), "");

console.log(`✓ gitlab markdown: ${Object.keys(attacks).length} casos XSS y el formato básico (incluidas imágenes) correctos`);
