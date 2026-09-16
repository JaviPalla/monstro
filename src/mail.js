"use strict";

/**
 * Bandeja de propuestas (Outlook / Microsoft 365 vía Microsoft Graph).
 *
 * Auth: DEVICE CODE FLOW. Sin servidor local de redirect, sin redirect URI que registrar y sin
 * MSAL: dos POST y polling. El refresh token se guarda en config.json (0600) y NUNCA sale al
 * renderer, igual que el token del proveedor.
 *
 * Requisito por instalación: un app registration en Azure AD marcado como *public client*
 * ("Allow public client flows" = sí) con el permiso DELEGADO Mail.ReadWrite. El clientId y el
 * tenant se configuran en Ajustes; sin ellos la sección no funciona.
 */

const config = require("./config");

// ReadWrite y no Read porque al convertir un correo en Epic lo marcamos como leído: esa es la
// señal de "ya procesado", visible en el propio Outlook y sin estado local que mantener.
const SCOPE = "offline_access Mail.ReadWrite";
const GRAPH = "https://graph.microsoft.com/v1.0";

const mailCfg = () => config.load().mail || {};

function authBase() {
  const tenant = mailCfg().tenant || "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

function clientId() {
  const id = mailCfg().clientId;
  if (!id) throw new Error("Falta el Client ID de Azure en Ajustes → Propuestas.");
  return id;
}

function saveMail(patch) {
  config.save({ mail: { ...mailCfg(), ...patch } });
}

// Errores de configuración de la app de Azure cuyo texto original no dice cómo arreglarlos.
const AZURE_HINTS = [
  // Tenant "common" con una app de un solo inquilino, o un Client ID que no es el de la app.
  [/AADSTS50(059|194)/, "Azure no encuentra la app: en Ajustes → Bandeja de propuestas, el Client ID es el «Id. de aplicación (cliente)» y el Tenant el «Id. de directorio (inquilino)»."],
  // App no marcada como cliente público: /devicecode funciona, pero el canje en /token pide un secreto.
  [/AADSTS7000218/, "La app de Azure no admite el código de dispositivo: en el portal, tu app → Autenticación → «Permitir flujos de cliente público» = Sí, y guarda."],
];

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = data.error_description || "";
    const hint = AZURE_HINTS.find(([re]) => re.test(desc))?.[1];
    const err = new Error(hint || desc || data.error || `HTTP ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

/* ---------- login ---------- */

/** Paso 1: código que el usuario teclea en microsoft.com/devicelogin. */
async function startLogin() {
  const d = await postForm(`${authBase()}/devicecode`, { client_id: clientId(), scope: SCOPE });
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    url: d.verification_uri,
    interval: d.interval || 5,
    expiresIn: d.expires_in,
  };
}

/**
 * Paso 2: UN intento de canje. Devuelve {pending:true} mientras el usuario no haya autorizado —
 * el polling lo lleva el renderer, así el main no se queda bloqueado minutos en un handler.
 */
async function pollLogin(deviceCode) {
  try {
    const d = await postForm(`${authBase()}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId(),
      device_code: String(deviceCode || ""),
    });
    saveMail({ refreshToken: d.refresh_token });
    cached = { token: d.access_token, expiresAt: Date.now() + (d.expires_in - 60) * 1000 };
    return { ok: true };
  } catch (err) {
    if (err.code === "authorization_pending") return { pending: true };
    throw err;
  }
}

function logout() {
  saveMail({ refreshToken: null });
  cached = null;
}

const status = () => ({
  configured: Boolean(mailCfg().clientId),
  connected: Boolean(mailCfg().refreshToken),
  folder: mailCfg().folder || "inbox",
});

/* ---------- llamadas a Graph ---------- */

// Access token en memoria: dura una hora larga, no merece la pena persistirlo.
let cached = null;

async function accessToken() {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const refreshToken = mailCfg().refreshToken;
  if (!refreshToken) throw new Error("No hay sesión de Outlook. Conecta la cuenta en Propuestas.");
  const d = await postForm(`${authBase()}/token`, {
    grant_type: "refresh_token",
    client_id: clientId(),
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  // Microsoft rota el refresh token en cada canje: si no se guarda el nuevo, la sesión caduca sola.
  if (d.refresh_token) saveMail({ refreshToken: d.refresh_token });
  cached = { token: d.access_token, expiresAt: Date.now() + (d.expires_in - 60) * 1000 };
  return cached.token;
}

async function graph(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Graph HTTP ${res.status}`);
  return data;
}

/**
 * Carpetas del buzón como rutas "Padre/Hija": primer nivel y un nivel de subcarpetas, que es donde
 * se suelen crear (p.ej. "Inbox/Propuestas"). Alimenta el desplegable de Ajustes y folderId().
 * ponytail: $expand no anida; para subcarpetas más hondas, recorrer /childFolders.
 */
async function mailFolders() {
  const data = await graph("/me/mailFolders?$top=100&$select=id,displayName&$expand=childFolders($select=id,displayName;$top=100)");
  return (data.value || []).flatMap((f) => [
    { id: f.id, path: f.displayName },
    ...(f.childFolders || []).map((c) => ({ id: c.id, path: `${f.displayName}/${c.displayName}` })),
  ]);
}

const listFolders = async () => (await mailFolders()).map((f) => f.path);

/**
 * Resuelve la carpeta configurada a un id de Graph. Primero por ruta; si no hay ninguna, se prueba
 * como well-known name ("inbox", "archive"…), que Graph acepta tal cual: así "inbox" vale aunque el
 * buzón esté en español, y una carpeta propia en minúsculas no se confunde con una well-known.
 */
async function folderId() {
  const name = (mailCfg().folder || "").trim() || "inbox";
  const hit = (await mailFolders()).find((f) => f.path.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  if (/^[a-z]+$/.test(name)) return name;
  throw new Error(`No existe la carpeta "${name}" en el buzón.`);
}

/**
 * Correos sin leer de la carpeta de propuestas, en texto plano. El header Prefer se lo pide a
 * Graph directamente: nos ahorra parsear el HTML del correo antes de dárselo a la IA.
 */
async function listProposals({ limit = 25 } = {}) {
  const id = await folderId();
  const query = `$select=id,subject,from,receivedDateTime,body&$top=${Math.min(50, Math.max(1, limit))}&$filter=isRead eq false&$orderby=receivedDateTime desc`;
  const data = await graph(`/me/mailFolders/${encodeURIComponent(id)}/messages?${query}`, {
    headers: { prefer: 'outlook.body-content-type="text"' },
  });
  return (data.value || []).map((m) => ({
    id: m.id,
    subject: m.subject || "(sin asunto)",
    from: m.from?.emailAddress?.address || "",
    receivedAt: m.receivedDateTime,
    body: (m.body?.content || "").trim(),
  }));
}

/** Marca el correo como leído: es el "ya convertido en Epic" que se ve desde el propio Outlook. */
const markProcessed = (messageId) => graph(`/me/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: { isRead: true } });

module.exports = { startLogin, pollLogin, logout, status, listProposals, listFolders, markProcessed };
