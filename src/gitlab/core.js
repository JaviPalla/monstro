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

// GitLab da markdown crudo (no HTML sanitizado). Lo escapamos y respetamos
// saltos de línea: no es markdown renderizado pero es seguro y legible.

function mdToSafeHtml(body) {
  if (!body) return "";
  return `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
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
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/png";
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
  resolveToken,
  settings,
  viewer,
  viewerRepos,
};
