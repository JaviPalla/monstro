"use strict";

// infraestructura compartida: config, token, llamadas a la API, helpers de escapado y mapeos comunes.
// Parte de la implementación del proveedor GitLab — ver src/gitlab.js para la interfaz pública.

const { execFileSync } = require("child_process");
const config = require("../config");

let cachedToken = null;

let cachedTokenSource = null;

function settings() {
  const cfg = config.load();
  const base = (cfg.gitlabBaseUrl || "https://gitlab.com").replace(/\/+$/, "");
  return { base, apiBase: `${base}/api/v4`, host: new URL(base).host };
}

function resolveToken() {
  if (cachedToken) return { token: cachedToken, source: cachedTokenSource };

  if (process.env.GITLAB_TOKEN) {
    cachedToken = process.env.GITLAB_TOKEN.trim();
    cachedTokenSource = "env:GITLAB_TOKEN";
    return { token: cachedToken, source: cachedTokenSource };
  }
  try {
    const { host } = settings();
    // OJO: en glab el flag es --host; -h es --help (devolvería el texto de ayuda).
    const out = execFileSync("glab", ["config", "get", "token", "--host", host], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out) {
      cachedToken = out;
      cachedTokenSource = "glab CLI";
      return { token: cachedToken, source: cachedTokenSource };
    }
  } catch {
    /* glab no disponible o sin login: probamos config */
  }
  const stored = config.load().token;
  if (stored) {
    cachedToken = stored;
    cachedTokenSource = "config.json";
    return { token: cachedToken, source: cachedTokenSource };
  }
  return { token: null, source: null };
}

function invalidateTokenCache() {
  cachedToken = null;
  cachedTokenSource = null;
}

async function api(method, path, body) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const { apiBase } = settings();
  const headers = { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app" };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}

/** Recorre todas las páginas (per_page=100) de un endpoint que devuelve un array. */

async function apiAll(path) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 5; page++) {
    const batch = await api("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }
  return out;
}

const proj = (repoFullName) => encodeURIComponent(repoFullName);

/* ---------- normalización (forma GitHub) ---------- */

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inversa de escapeHtml, para recuperar una URL real a partir de un atributo ya escapado (hay que
// pedirle a fetch() la URL de verdad, no "...&amp;..."). &amp; siempre al final: si no, "&amp;lt;"
// se leería "<" en vez de "&lt;".
function unescapeHtml(text) {
  return String(text || "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

// GitLab da markdown crudo (no HTML sanitizado): se escapa TODO primero y solo después se
// transforma sobre lo ya escapado (nada del markdown puede abrir una etiqueta ni salirse de un
// atributo). A diferencia de renderer/app/markdown.js (mismo patrón, para transcripts de sesión,
// sin imágenes a propósito: texto que puede venir de fuera), aquí SÍ se admiten <img>: el cuerpo
// es tuyo o de tu equipo en tu propio GitLab, igual que el bodyHTML que ya manda GitHub sin tocar.

const GL_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const GL_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
const GL_QUOTE_RE = /^&gt;\s?/;
// Adjunto de GitLab (captura de pantalla pegada en una nota): llega como ruta relativa al proyecto.
const GL_UPLOAD_RE = /(\]\()(\/uploads\/[^\s)]+)(\))/g;
const GL_AUTOLINK_RE = /(^|[\s(*])(https:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s()\u0000])+)/g;

const glLink = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
// GitLab deja poner tamaño tras la imagen: "![alt](url){width=496 height=290}" (lo pegas así al
// arrastrar una captura). Si no se consume aquí, el "{width=...}" se cuela como texto suelto.
function glImage(url, alt, attrs) {
  const w = attrs && /width=(\d+)/.exec(attrs);
  const h = attrs && /height=(\d+)/.exec(attrs);
  return `<img src="${url}" alt="${alt}"${w ? ` width="${w[1]}"` : ""}${h ? ` height="${h[1]}"` : ""} loading="lazy">`;
}

const glEmphasis = (text) => text
  .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^\w])__(?=\S)(.+?)__(?!\w)/g, "$1<strong>$2</strong>")
  .replace(/(^|[^*\w])\*(?=[^\s*])([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
  .replace(/(^|[^\w])_(?=[^\s_])([^_]+?)_(?!\w)/g, "$1<em>$2</em>") // snake_case no es cursiva
  .replace(/~~(?=\S)(.+?)~~/g, "<del>$1</del>");

// Imagen / enlace / autolink / código se apartan en marcadores para que la negrita no los toque.
// Solo https:// (y los /uploads/ relativos, ya resueltos antes de escapar): igual que el renderer
// de sesiones, nada de javascript:/data:.
function glInline(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let out = text
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`))
    .replace(/!\[([^\]]*)\]\((https:\/\/[^\s()]+)\)(\{[^}\n]*\})?/g, (_, alt, url, attrs) => keep(glImage(url, alt, attrs)))
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s()]+)\)/g, (_, label, url) => keep(glLink(url, glEmphasis(label))))
    .replace(GL_AUTOLINK_RE, (_, lead, raw) => {
      const url = raw.replace(/[.,;:!?*_~]+$/, "");
      return lead + keep(glLink(url, url)) + raw.slice(url.length);
    });
  out = glEmphasis(out);
  while (/\u0000\d+\u0000/.test(out)) out = out.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[n]);
  return out;
}

// Una lista sin anidar (checklists de GitLab incluidas: "- [ ] foo" -> checkbox deshabilitado).
function glList(lines, start) {
  const ordered = /\d/.test(GL_ITEM_RE.exec(lines[start])[2]);
  const items = [];
  let i = start;
  for (; i < lines.length; i++) {
    const m = GL_ITEM_RE.exec(lines[i]);
    if (!m) break;
    const task = /^\[([ xX])\]\s+/.exec(m[3]);
    const body = task ? m[3].slice(task[0].length) : m[3];
    const check = task ? `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ` : "";
    items.push(`<li>${check}${glInline(body)}</li>`);
  }
  return { html: `${ordered ? "<ol>" : "<ul>"}${items.join("")}${ordered ? "</ol>" : "</ul>"}`, next: i };
}

function glBlocks(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(glInline).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = GL_FENCE_RE.exec(line))) {
      flush();
      const fence = m[2];
      const code = [];
      while (++i < lines.length && !(lines[i].trim().startsWith(fence) && /^[`~]+$/.test(lines[i].trim()))) code.push(lines[i]);
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
    } else if (!line.trim()) {
      flush();
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(line))) {
      flush();
      out.push(`<h${m[1].length}>${glInline(m[2])}</h${m[1].length}>`);
    } else if (GL_QUOTE_RE.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && GL_QUOTE_RE.test(lines[i])) quote.push(lines[i++].replace(GL_QUOTE_RE, ""));
      i--;
      out.push(`<blockquote>${glBlocks(quote)}</blockquote>`);
    } else if (GL_ITEM_RE.test(line)) {
      flush();
      const list = glList(lines, i);
      out.push(list.html);
      i = list.next - 1;
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out.join("");
}

// Pura (sin tocar config/settings): así se puede probar con `node`, sin Electron.
function renderGitlabMarkdown(body) {
  if (!body) return "";
  return glBlocks(escapeHtml(String(body)).replace(/\r\n?/g, "\n").split("\n"));
}

// Las capturas pegadas en una nota llegan como "/uploads/<hash>/nombre.png", relativas al proyecto:
// se resuelven contra su URL ANTES de escapar (si no hay repoFullName, se dejan tal cual y no
// se enlazan/renderizan, igual que cualquier otro enlace no-https).
function resolveUploadPaths(body, base, repoFullName) {
  if (!repoFullName) return body;
  return body.replace(GL_UPLOAD_RE, (_, open, rel, close) => `${open}${base}/${repoFullName}${rel}${close}`);
}

// Un <img src> del renderer no puede llevar cabeceras: en una instancia privada, GitLab responde
// 401 a esas rutas sin el PRIVATE-TOKEN (mismo motivo que fetchAvatarDataUri) y la imagen sale
// rota. Se traen aquí (solo las del propio host de GitLab; una externa carga tal cual, no necesita
// el token) y se embeben como data-URI. Si la descarga falla (borrada, sin permiso), se deja como
// enlace en vez de un icono roto.
async function inlineGitlabImages(html, host) {
  const urls = [...new Set([...html.matchAll(/<img src="([^"]+)"/g)].map((m) => unescapeHtml(m[1])))]
    .filter((u) => { try { return new URL(u).host === host; } catch { return false; } });
  if (!urls.length) return html;
  const dataUris = await mapLimit(urls, 4, (u) => fetchAvatarDataUri(u));
  const byUrl = new Map(urls.map((u, i) => [u, dataUris[i]]));
  // El resto del tag (alt, width/height, loading) se conserva tal cual; solo cambia el src.
  return html.replace(/<img src="([^"]+)"([^>]*)>/g, (full, rawUrl, rest) => {
    const url = unescapeHtml(rawUrl);
    if (!byUrl.has(url)) return full; // no era del host de GitLab: se deja tal cual
    const dataUri = byUrl.get(url);
    if (dataUri) return `<img src="${dataUri}"${rest}>`;
    const alt = /alt="([^"]*)"/.exec(rest)?.[1];
    return `<a href="${rawUrl}" target="_blank" rel="noopener noreferrer">${alt || "imagen"}</a>`;
  });
}

async function mdToSafeHtml(body, repoFullName) {
  if (!body) return "";
  const { base, host } = settings();
  const html = renderGitlabMarkdown(resolveUploadPaths(String(body), base, repoFullName));
  return inlineGitlabImages(html, host);
}

function mapUser(u) {
  return u ? { login: u.username, avatarUrl: u.avatar_url } : null;
}

function mapPipeline(pipeline) {
  if (!pipeline || !pipeline.status) return null;
  const map = {
    success: "SUCCESS",
    failed: "FAILURE",
    canceled: "ERROR",
    skipped: "SUCCESS",
    manual: "PENDING",
    running: "PENDING",
    pending: "PENDING",
    created: "PENDING",
    preparing: "PENDING",
    scheduled: "PENDING",
    waiting_for_resource: "PENDING",
  };
  const state = map[pipeline.status] || "EXPECTED";
  return { state, contexts: { nodes: [] } };
}

// approvals (/approvals) + reviewers -> reviewDecision, latestReviews (facepile),
// reviewRequests (dock badge "awaiting my review").

function encodeId(repoFullName, iid) {
  return `gl:${encodeURIComponent(repoFullName)}#${iid}`;
}

function decodeId(id) {
  const m = /^gl:([^#]+)#(\d+)$/.exec(id || "");
  if (!m) throw new Error(`id GitLab no válido: ${id}`);
  return { repo: decodeURIComponent(m[1]), iid: Number(m[2]) };
}

/* ---------- interfaz pública ---------- */

async function viewer() {
  const me = await api("GET", "/user");
  return { id: me.id, login: me.username, avatarUrl: me.avatar_url };
}

async function viewerRepos() {
  // Sin simple=true: necesitamos `visibility` para el chip "privado".
  const projects = await api(
    "GET",
    "/projects?membership=true&order_by=last_activity_at&archived=false&per_page=50",
  );
  return projects.map((p) => ({ nameWithOwner: p.path_with_namespace, isPrivate: p.visibility !== "public" }));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Trocea un array en lotes de tamaño n (para no reventar el límite de complejidad de GraphQL
// de GitLab: una query con decenas de alias + connections anidados se rechaza entera).

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchAvatarDataUri(url) {
  try {
    const { token } = resolveToken();
    if (!token) return null;
    // fetch() sigue el 302 solo: algunas rutas de /uploads/ (adjuntos de notas, en ciertas
    // instancias) no aceptan PRIVATE-TOKEN y redirigen a /users/sign_in, que responde 200
    // text/html — sin comprobar el content-type esto devolvía la página de login disfrazada
    // de imagen (un <img> con esos bytes no se pinta: icono roto, aunque res.ok sea true).
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app" } });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Proyectos del grupo (incl. subgrupos) con su icono ya resuelto a data-URI, para el filtro
// por proyecto del resumen. ponytail: trae todos los del grupo y proxea los que tengan avatar
// (una vez, el renderer cachea); si el grupo fuese enorme, limitar a los presentes en el milestone.

async function graphql(query, variables) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const { base } = settings();
  const res = await fetch(`${base}/api/graphql`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message || `GraphQL HTTP ${res.status}`);
  return json.data;
}

// Padre (jerarquía de work items) de varios work items en UNA sola query con alias. Devuelve
// Map<gid, parent|null> donde parent = {id, title, webUrl, workItemType:{name}}.

module.exports = {
  api,
  apiAll,
  cachedToken,
  cachedTokenSource,
  chunk,
  decodeId,
  encodeId,
  escapeHtml,
  fetchAvatarDataUri,
  graphql,
  invalidateTokenCache,
  mapLimit,
  mapPipeline,
  mapUser,
  mdToSafeHtml,
  proj,
  renderGitlabMarkdown,
  resolveToken,
  resolveUploadPaths,
  settings,
  viewer,
  viewerRepos,
};
