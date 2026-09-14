"use strict";

/* ============ markdown → HTML seguro, sin dependencias (CSP estricta, sin libs) ============ */
// Para el plan y el último mensaje de Claude en la ficha de una sesión (sessions-view.js). Se ESCAPA TODO
// el texto primero y solo después se transforma sobre lo ya escapado: nada del markdown puede abrir una
// etiqueta ni salirse de un atributo. Enlaces solo https:// (y con target=_blank, que main manda al
// navegador). Casos XSS y de formato en scripts/test-markdown.js. Sin DOM: se evalúa también en node.

const MD_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
const MD_TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const MD_HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const MD_QUOTE_RE = /^\s{0,3}&gt;/;
// URL suelta: se corta antes de una comilla/ángulo ya escapados, y la puntuación final no es parte de ella.
const MD_AUTOLINK_RE = /(^|[\s(*])(https:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s()\u0000])+)/g;

function mdEscape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const mdLink = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

const mdEmphasis = (text) => text
  .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^\w])__(?=\S)(.+?)__(?!\w)/g, "$1<strong>$2</strong>")
  .replace(/(^|[^*\w])\*(?=[^\s*])([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
  .replace(/(^|[^\w])_(?=[^\s_])([^_]+?)_(?!\w)/g, "$1<em>$2</em>") // snake_case no es cursiva
  .replace(/~~(?=\S)(.+?)~~/g, "<del>$1</del>");

// Código y enlaces se apartan en marcadores (\u0000n\u0000) para que la negrita/cursiva no los toque.
function mdInline(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let out = text
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s()]+)\)/g, (_, label, url) => keep(mdLink(url, mdEmphasis(label))))
    .replace(MD_AUTOLINK_RE, (_, lead, raw) => {
      const url = raw.replace(/[.,;:!?*_~]+$/, "");
      return lead + keep(mdLink(url, url)) + raw.slice(url.length);
    });
  out = mdEmphasis(out);
  while (/\u0000\d+\u0000/.test(out)) out = out.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[n]);
  return out;
}

function mdItemHtml(item) {
  const task = /^\[([ xX])\]\s+/.exec(item.text[0]);
  if (task) item.text[0] = item.text[0].slice(task[0].length);
  const check = task ? `<span class="md-check">${task[1] === " " ? "☐" : "☑"}</span> ` : "";
  return `<li${task ? ' class="md-task"' : ""}>${check}${item.text.map(mdInline).join("<br>")}${item.sub.join("")}</li>`;
}

// Una lista con, como mucho, un nivel anidado (lo más sangrado de ahí se aplana en ese nivel).
function mdList(lines, start, depth = 0) {
  const first = MD_ITEM_RE.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = MD_ITEM_RE.exec(line);
    if (!line.trim()) {
      // Tras una línea en blanco la lista sigue solo si viene otro punto o algo sangrado.
      const next = lines[i + 1] ?? "";
      const nextItem = MD_ITEM_RE.exec(next);
      if ((nextItem && nextItem[1].length >= base) || /^\s{2,}\S/.test(next)) { i++; continue; }
      break;
    }
    if (MD_FENCE_RE.test(line)) break;
    if (m) {
      const indent = m[1].length;
      if (indent < base) break; // vuelve a la lista de fuera
      if (indent <= base + 1 || depth > 0 || !items.length) {
        if (indent <= base + 1 && /\d/.test(m[2]) !== ordered) break;
        items.push({ text: [m[3]], sub: [] });
        i++;
        continue;
      }
      const nested = mdList(lines, i, depth + 1);
      items.at(-1).sub.push(nested.html);
      i = nested.next;
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    const blockStart = /^#{1,6}\s/.test(line) || MD_HR_RE.test(line) || MD_QUOTE_RE.test(line);
    if ((depth > 0 && indent < base) || (indent === 0 && blockStart)) break;
    items.at(-1).text.push(line.trim()); // continuación del punto
    i++;
  }
  const number = Number(first[2].replace(/\D/g, ""));
  const open = ordered ? `<ol${number > 1 ? ` start="${number}"` : ""}>` : "<ul>";
  return { html: `${open}${items.map(mdItemHtml).join("")}${ordered ? "</ol>" : "</ul>"}`, next: i };
}

function mdTable(lines, i) {
  const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
  const head = cells(lines[i]);
  const rows = [];
  let next = i + 2;
  while (next < lines.length && lines[next].includes("|") && lines[next].trim()) rows.push(cells(lines[next++]));
  const cell = (tag, text, k) => `<${tag}${align[k] ? ` class="md-${align[k]}"` : ""}>${mdInline(text)}</${tag}>`;
  const body = rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("");
  return { html: `<div class="md-table"><table><thead><tr>${head.map((h, k) => cell("th", h, k)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`, next };
}

function mdBlocks(lines, depth = 0) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = MD_FENCE_RE.exec(line))) {
      flush();
      const [indent, fence] = [m[1].length, m[2]];
      const code = [];
      while (++i < lines.length && !(lines[i].trim().startsWith(fence) && /^[`~]+$/.test(lines[i].trim()))) {
        code.push(lines[i].slice(Math.min(indent, lines[i].match(/^\s*/)[0].length)));
      }
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
    } else if (!line.trim()) {
      flush();
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/.exec(line))) {
      flush();
      out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
    } else if (MD_HR_RE.test(line)) {
      flush();
      out.push("<hr>");
    } else if (MD_QUOTE_RE.test(line) && depth < 4) {
      flush();
      const quote = [];
      while (i < lines.length && MD_QUOTE_RE.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}&gt;\s?/, ""));
      i--;
      out.push(`<blockquote>${mdBlocks(quote, depth + 1)}</blockquote>`);
    } else if (line.includes("|") && MD_TABLE_SEP_RE.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("|")) {
      flush();
      const table = mdTable(lines, i);
      out.push(table.html);
      i = table.next - 1;
    } else if (MD_ITEM_RE.test(line) && !MD_HR_RE.test(line)) {
      flush();
      const list = mdList(lines, i);
      out.push(list.html);
      i = list.next - 1;
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out.join("");
}

function renderMarkdown(md) {
  const text = String(md ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  return text.trim() ? mdBlocks(mdEscape(text).split("\n")) : "";
}
