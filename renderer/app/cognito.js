"use strict";

// Vista de Usuarios (Cognito): buscar por email, user id (sub) o username en una pool de la cuenta de
// AWS y ver TODOS los atributos del usuario para resolver incidencias. Solo lectura. Va por el `aws`
// CLI del Mac: el perfil se elige aquí mismo y se recuerda en config.cognito; Monstro no guarda
// credenciales de AWS.

// Regiones que se ofrecen; el backend acepta cualquier región válida, aquí solo las que usa la cuenta.
const COGNITO_REGIONS = ["eu-west-1", "us-east-1"];

const COGNITO_STATUS_CLS = {
  CONFIRMED: "ok",
  UNCONFIRMED: "warn",
  FORCE_CHANGE_PASSWORD: "warn",
  RESET_REQUIRED: "warn",
  COMPROMISED: "err",
  ARCHIVED: "err",
};

async function enterCognito() {
  state.view = "cognito";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-usuarios")?.classList.add("active");
  const c = state.cognito;
  if (!c.profiles.length) c.profiles = await window.monstro.cognitoProfiles().catch(() => []);
  await loadCognitoPools();
}

async function loadCognitoPools() {
  const c = state.cognito;
  Object.assign(c, { pools: [], poolId: null, users: null, user: null, selected: null, error: null, loading: true });
  renderCognito();
  try {
    c.pools = await window.monstro.cognitoPools();
    const saved = state.config?.cognito?.poolId;
    c.poolId = c.pools.some((p) => p.id === saved) ? saved : c.pools[0]?.id || null;
  } catch (err) {
    c.error = String(err.message || err);
  }
  c.loading = false;
  renderCognito();
  if (c.poolId) await searchCognito();
  else notifySelftestOnce();
}

async function searchCognito() {
  const c = state.cognito;
  if (!c.poolId) return;
  Object.assign(c, { loading: true, error: null, user: null, selected: null });
  renderCognito();
  try {
    c.users = await window.monstro.cognitoUsers(c.poolId, c.q);
  } catch (err) {
    c.users = null;
    c.error = String(err.message || err);
  }
  c.loading = false;
  renderCognito();
  // En el selftest se abre la ficha del primero para que la captura enseñe las dos mitades.
  if (IS_SELFTEST && c.users?.length) await openCognitoUser(c.users[0].username);
  notifySelftestOnce();
}

async function openCognitoUser(username) {
  const c = state.cognito;
  Object.assign(c, { selected: username, user: null, userError: null });
  renderCognito();
  try {
    c.user = await window.monstro.cognitoUser(c.poolId, username);
  } catch (err) {
    c.userError = String(err.message || err);
  }
  renderCognito();
}

function cognitoStatusHtml(u) {
  if (u.enabled === false) return `<span class="cg-status err">${t("Deshabilitado")}</span>`;
  return `<span class="cg-status ${COGNITO_STATUS_CLS[u.status] || ""}">${esc(u.status || "")}</span>`;
}

const cgDate = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

// Fila clave → valor de la ficha. El valor va en <code> con user-select: all (un clic lo selecciona
// entero) y un botón de copiar que solo aparece al pasar el ratón.
function cgPropRow(name, value) {
  const v = value == null || value === "" ? "" : String(value);
  return `<tr>
    <th>${esc(name)}</th>
    <td>${v ? `<code>${esc(v)}</code><button class="icon-btn cg-copy" data-copy="${esc(v)}" title="${t("Copiar")}">${icon("copy")}</button>` : `<span class="muted">—</span>`}</td>
  </tr>`;
}

function cognitoDetailHtml() {
  const c = state.cognito;
  if (!c.selected) return `<div class="empty">${t("Elige un usuario para ver su ficha")}</div>`;
  if (c.userError) return `<div class="error-box">${esc(c.userError)}</div>`;
  const u = c.user;
  if (!u) return `<div class="loading">${t("Cargando…")}</div>`;
  const meta = [
    [t("Estado"), u.status],
    [t("Habilitado"), u.enabled ? t("sí") : t("no")],
    [t("Creado"), cgDate(u.created)],
    [t("Modificado"), cgDate(u.modified)],
    [t("MFA"), u.mfa.length ? u.mfa.join(", ") : ""],
    [t("MFA preferido"), u.preferredMfa],
    [t("Grupos"), u.groups.join(", ")],
  ];
  return `
    <h3>
      ${icon("user")} ${esc(u.username)} ${cognitoStatusHtml(u)}
      <button id="cg-console" class="btn cg-console" title="${esc(t("Abrir la ficha en la consola de AWS con la sesión iniciada"))}">${icon("external-link")} ${t("Abrir en AWS")}</button>
    </h3>
    <table class="cg-props">
      <tbody>
        ${cgPropRow("Username", u.username)}
        ${meta.map(([k, v]) => cgPropRow(k, v)).join("")}
      </tbody>
    </table>
    <div class="cg-section">${t("Atributos")} · ${u.attributes.length}</div>
    <table class="cg-props">
      <tbody>${u.attributes.map((a) => cgPropRow(a.name, a.value)).join("")}</tbody>
    </table>`;
}

function cognitoResultsHtml() {
  const c = state.cognito;
  if (c.error) return `<div class="error-box">${esc(c.error)}</div>`;
  if (c.loading) return `<div class="loading">${t("Buscando…")}</div>`;
  if (!c.users) return `<div class="empty">${t("Elige una pool para empezar")}</div>`;
  if (!c.users.length) return `<div class="empty">${t("Sin resultados")}</div>`;
  const rows = c.users
    .map(
      (u) => `<tr data-username="${esc(u.username)}" class="${u.username === c.selected ? "selected" : ""}">
        <td title="${esc(u.username)}">${esc(u.username)}</td>
        <td title="${esc(u.email)}">${esc(u.email)}</td>
        <td>${cognitoStatusHtml(u)}</td>
        <td class="muted">${esc(timeAgo(u.created))}</td>
      </tr>`,
    )
    .join("");
  const cap = c.users.length >= 60 ? ` · ${t("solo los primeros 60, afina la búsqueda")}` : "";
  return `
    <div class="cg-count muted">${t("{n} usuarios", { n: c.users.length })}${cap}</div>
    <table class="cg-table">
      <thead><tr><th>Username</th><th>Email</th><th>${t("Estado")}</th><th>${t("Creado")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderCognito() {
  if (state.view !== "cognito") return;
  const c = state.cognito;
  const profile = state.config?.cognito?.profile || "";
  const profileOpts = [
    `<option value="">${t("perfil por defecto")}</option>`,
    ...c.profiles.map((p) => `<option value="${esc(p)}" ${p === profile ? "selected" : ""}>${esc(p)}</option>`),
  ].join("");
  const poolOpts = c.pools
    .map((p) => `<option value="${esc(p.id)}" ${p.id === c.poolId ? "selected" : ""}>${esc(p.name)} · ${esc(p.id)}</option>`)
    .join("");
  const region = state.config?.cognito?.region || COGNITO_REGIONS[0];
  const regionOpts = COGNITO_REGIONS.map((r) => `<option value="${r}" ${r === region ? "selected" : ""}>${r}</option>`).join("");
  const ready = Boolean(c.poolId);

  list.innerHTML = `
    <div class="ms-filters cg-bar">
      <label class="cg-field">${t("Perfil AWS")} <select id="cg-profile">${profileOpts}</select></label>
      <label class="cg-field">${t("Región")} <select id="cg-region">${regionOpts}</select></label>
      <label class="cg-field">${t("Pool")} <select id="cg-pool" ${c.pools.length ? "" : "disabled"}>${poolOpts || `<option>${t("sin pools")}</option>`}</select></label>
      <div class="cg-search">
        ${icon("search")}
        <input id="cg-q" type="search" placeholder="${esc(t("email, user id (sub) o username…"))}" value="${esc(c.q)}" ${ready ? "" : "disabled"} />
        <button id="cg-go" class="btn" ${ready ? "" : "disabled"}>${t("Buscar")}</button>
      </div>
    </div>
    <div class="cg-body">
      <div class="cg-results">${cognitoResultsHtml()}</div>
      <div class="cg-detail">${cognitoDetailHtml()}</div>
    </div>`;

  // Perfil y región cambian la cuenta/ubicación: se guardan (el backend los lee de config en cada
  // llamada) y se vuelven a cargar las pools desde cero.
  const saveAndReload = (key) => async (ev) => {
    const value = ev.target.value || null;
    if (!IS_SELFTEST) state.config = await window.monstro.setConfig({ cognito: { [key]: value } });
    else state.config = { ...state.config, cognito: { ...state.config?.cognito, [key]: value } };
    loadCognitoPools();
  };
  $("#cg-profile").addEventListener("change", saveAndReload("profile"));
  $("#cg-region").addEventListener("change", saveAndReload("region"));
  $("#cg-pool").addEventListener("change", (ev) => {
    c.poolId = ev.target.value;
    if (!IS_SELFTEST) window.monstro.setConfig({ cognito: { poolId: c.poolId } }).catch(() => {});
    searchCognito();
  });
  const input = $("#cg-q");
  input.addEventListener("input", () => (c.q = input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") searchCognito();
  });
  $("#cg-go").addEventListener("click", searchCognito);
  list.querySelectorAll(".cg-table tr[data-username]").forEach((tr) =>
    tr.addEventListener("click", () => openCognitoUser(tr.dataset.username)),
  );
  $("#cg-console")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const { url, federated } = await window.monstro.cognitoConsole(c.poolId, c.selected);
      if (!federated) toast(t("Tu perfil no puede federar la sesión: se abre la consola sin iniciar sesión"), "warn");
      await window.monstro.openExternal(url);
    } catch (err) {
      toast(String(err.message || err), "err");
    } finally {
      btn.disabled = false;
    }
  });
  list.querySelectorAll(".cg-copy[data-copy]").forEach((btn) =>
    btn.addEventListener("click", () => navigator.clipboard.writeText(btn.dataset.copy).then(() => toast(t("Copiado"), "ok"))),
  );
}
