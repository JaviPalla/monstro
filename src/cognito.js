"use strict";

// Usuarios de Cognito (AWS) a través del `aws` CLI ya configurado en el Mac: Monstro no lleva SDK ni
// guarda credenciales, manda el perfil de ~/.aws (config.cognito.profile). Solo lecturas:
// list-user-pools, list-users, admin-get-user y admin-list-groups-for-user.

const { execFile } = require("child_process");
const { promisify } = require("util");
const config = require("./config");

const pexec = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(service, args) {
  const cfg = config.load().cognito;
  const full = [service, ...args, "--region", cfg.region, "--output", "json"];
  if (cfg.profile) full.push("--profile", cfg.profile);
  try {
    const { stdout } = await pexec("aws", full, { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, AWS_PAGER: "" } });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("No se encuentra el `aws` CLI (brew install awscli)");
    // El CLI deja el motivo en stderr: "An error occurred (AccessDeniedException) when calling …: <detalle>".
    const line = String(err.stderr || "").trim().split("\n").filter(Boolean).pop();
    throw new Error(line || err.message);
  }
}

const aws = (args) => run("cognito-idp", args);

async function profiles() {
  const { stdout } = await pexec("aws", ["configure", "list-profiles"]).catch(() => ({ stdout: "" }));
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function pools() {
  const res = await aws(["list-user-pools", "--max-results", "60"]);
  return (res.UserPools || []).map((p) => ({ id: p.Id, name: p.Name })).sort((a, b) => a.name.localeCompare(b.name));
}

const attrs = (list) => Object.fromEntries((list || []).map((a) => [a.Name, a.Value]));

function row(u) {
  const a = attrs(u.Attributes || u.UserAttributes);
  return {
    username: u.Username,
    enabled: u.Enabled,
    status: u.UserStatus,
    created: u.UserCreateDate,
    modified: u.UserLastModifiedDate,
    email: a.email || "",
    sub: a.sub || "",
  };
}

// ListUsers admite UN filtro por llamada y solo sobre atributos estándar, así que la pinta del texto
// decide: UUID → sub exacto; con @ → email por prefijo; si no, email Y username por prefijo en
// paralelo, fusionando por Username. Vacío = los primeros 60 de la pool, para curiosear.
// ponytail: sin paginación; 60 resultados es de sobra para una búsqueda de incidencia.
async function users(poolId, q) {
  const base = ["list-users", "--user-pool-id", poolId, "--limit", "60"];
  const filters = !q
    ? [null]
    : UUID_RE.test(q)
      ? [`sub = "${q}"`]
      : q.includes("@")
        ? [`email ^= "${q}"`]
        : [`email ^= "${q}"`, `username ^= "${q}"`];
  const results = await Promise.all(filters.map((f) => aws(f ? [...base, "--filter", f] : base)));
  const seen = new Map();
  for (const r of results) for (const u of r.Users || []) if (!seen.has(u.Username)) seen.set(u.Username, row(u));
  return [...seen.values()].sort((a, b) => a.username.localeCompare(b.username));
}

async function user(poolId, username) {
  const [u, g] = await Promise.all([
    aws(["admin-get-user", "--user-pool-id", poolId, "--username", username]),
    aws(["admin-list-groups-for-user", "--user-pool-id", poolId, "--username", username]).catch(() => ({ Groups: [] })),
  ]);
  return {
    ...row(u),
    mfa: [...(u.UserMFASettingList || []), ...(u.MFAOptions || []).map((m) => m.DeliveryMedium)],
    preferredMfa: u.PreferredMfaSetting || null,
    groups: (g.Groups || []).map((x) => x.GroupName),
    attributes: (u.UserAttributes || []).map((a) => ({ name: a.Name, value: a.Value })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Ficha del usuario en la consola de AWS con la sesión ya iniciada: credenciales federadas de STS
// (permisos = los del perfil ∩ cognito-idp:*, nunca más que el IAM user) → SigninToken del endpoint
// de federación → URL de login con la ficha como destino. Si el perfil no puede federar (sin
// sts:GetFederationToken), se devuelve la URL de la consola a secas y el navegador pedirá login.
async function consoleUrl(poolId, username) {
  const { region } = config.load().cognito;
  const dest = `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${poolId}/users/details/${encodeURIComponent(username)}?region=${region}`;
  let fed;
  try {
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "cognito-idp:*", Resource: "*" }] });
    fed = await run("sts", ["get-federation-token", "--name", "monstro", "--policy", policy, "--duration-seconds", "3600"]);
  } catch (err) {
    return { url: dest, federated: false, note: err.message };
  }
  const c = fed.Credentials;
  const session = JSON.stringify({ sessionId: c.AccessKeyId, sessionKey: c.SecretAccessKey, sessionToken: c.SessionToken });
  const res = await fetch(`https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(session)}`);
  if (!res.ok) throw new Error(`signin.aws.amazon.com: HTTP ${res.status}`);
  const { SigninToken } = await res.json();
  return {
    url: `https://signin.aws.amazon.com/federation?Action=login&Issuer=monstro&Destination=${encodeURIComponent(dest)}&SigninToken=${encodeURIComponent(SigninToken)}`,
    federated: true,
  };
}

module.exports = { profiles, pools, users, user, consoleUrl };
