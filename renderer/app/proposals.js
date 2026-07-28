"use strict";

// Vista de Propuestas (solo GitLab): lee la bandeja de Outlook donde entran propuestas de nuevas
// funcionalidades y las convierte en una Epic con sus tareas hijas.
//
// El correo NO crea nada por su cuenta. La IA devuelve un BORRADOR que se muestra aquí; hasta que
// no se pulsa "Crear en GitLab" no se escribe nada, igual que las review drafts y los cherry-picks.
// Al crearla, el correo se marca como leído en Outlook: esa es la señal de "ya procesado", así no
// hace falta mantener una lista local de correos vistos.

async function enterProposals() {
  if (!isGitlab()) {
    toast(t("La vista de Propuestas solo está disponible en GitLab"), "");
    return;
  }
  state.view = "proposals";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-propuestas")?.classList.add("active");
  renderProposals();
  await refreshProposals();
}

async function refreshProposals() {
  const p = state.proposals;
  p.loading = true;
  p.error = "";
  renderProposals();
  try {
    p.status = await window.monstro.mailStatus();
    p.emails = p.status.connected ? await window.monstro.mailList() : [];
  } catch (err) {
    p.error = String(err.message || err);
    p.emails = [];
  }
  p.loading = false;
  renderProposals();
}

/* ---------- conexión con Outlook (device code) ---------- */

async function startMailLogin() {
  const p = state.proposals;
  try {
    p.login = await window.monstro.mailStartLogin();
    renderProposals();
    pollMailLogin();
  } catch (err) {
    p.error = String(err.message || err);
    renderProposals();
  }
}

// Polling desde el renderer y no desde el main: un handler IPC bloqueado varios minutos esperando a
// que el usuario teclee el código dejaría la ventana sin respuesta.
async function pollMailLogin() {
  const p = state.proposals;
  const deadline = Date.now() + (p.login?.expiresIn || 900) * 1000;
  while (p.login && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (p.login.interval || 5) * 1000));
    if (!p.login) return; // cancelado mientras dormía
    try {
      const res = await window.monstro.mailPollLogin(p.login.deviceCode);
      if (res.ok) {
        p.login = null;
        toast(t("Cuenta de Outlook conectada"), "ok");
        await refreshProposals();
        return;
      }
    } catch (err) {
      p.login = null;
      p.error = String(err.message || err);
      renderProposals();
      return;
    }
  }
  if (p.login) {
    p.login = null;
    p.error = t("El código ha caducado. Vuelve a intentarlo.");
    renderProposals();
  }
}

async function disconnectMail() {
  state.proposals.status = await window.monstro.mailLogout();
  state.proposals.emails = [];
  renderProposals();
}

/* ---------- correo → borrador → GitLab ---------- */

async function proposeFromEmail(emailId) {
  const p = state.proposals;
  const email = p.emails.find((e) => e.id === emailId);
  if (!email || p.busy) return;
  p.busy = true;
  p.error = "";
  renderProposals();
  try {
    const draft = await window.monstro.mailPropose(email);
    // `skip` = tareas que el usuario descarta antes de crear (la IA a veces mete proyectos de más).
    p.draft = { ...draft, email, skip: new Set() };
  } catch (err) {
    p.error = String(err.message || err);
  }
  p.busy = false;
  renderProposals();
}

async function createFromDraft() {
  const p = state.proposals;
  const d = p.draft;
  if (!d || p.busy) return;
  const tasks = d.tasks.filter((_, i) => !d.skip.has(i));
  if (!tasks.length) {
    toast(t("Selecciona al menos una tarea"), "");
    return;
  }
  p.busy = true;
  renderProposals();
  try {
    p.results = await window.monstro.mailCreate({
      epicTitle: $("#prop-epic-title")?.value || d.epicTitle,
      epicDescription: $("#prop-epic-desc")?.value || d.epicDescription,
      tasks,
      labels: d.labels,
      // ponytail: sin selector de milestone — se asigna en GitLab. Añadir si se pide.
      milestoneId: null,
      messageId: d.email.id,
    });
    p.draft = null;
    toast(t("Epic creada"), "ok");
    await refreshProposals();
  } catch (err) {
    p.error = String(err.message || err);
  }
  p.busy = false;
  renderProposals();
}

/* ---------- render ---------- */

function renderProposals() {
  if (state.view !== "proposals") return;
  const list = $("#pr-list");
  const p = state.proposals;
  const error = p.error ? `<div class="error-box">${esc(p.error)}</div>` : "";

  if (p.draft) {
    list.innerHTML = error + renderProposalDraft(p);
    wireDraftEvents(p);
    return;
  }
  if (!p.status) {
    list.innerHTML = error + `<div class="loading">${t("Cargando…")}</div>`;
    return;
  }
  if (!p.status.configured) {
    list.innerHTML = `${error}<div class="empty">
      <p>${t("Configura el Client ID de Azure en Ajustes para leer la bandeja de propuestas.")}</p>
      <p class="muted">${t("Ajustes → Bandeja de propuestas explica paso a paso de dónde sacarlo.")}</p>
      <button id="prop-settings" class="btn btn-primary">${t("Ir a Ajustes")}</button>
    </div>`;
    $("#prop-settings")?.addEventListener("click", openSettings);
    return;
  }
  if (!p.status.connected) {
    list.innerHTML = error + renderMailLogin(p);
    $("#prop-connect")?.addEventListener("click", startMailLogin);
    $("#prop-login-url")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.monstro.openExternal(p.login.url);
    });
    return;
  }

  const rows = p.emails
    .map(
      (e) => `<div class="prop-row">
        <div class="prop-main">
          <div class="prop-subject">${esc(e.subject)}</div>
          <div class="muted">${esc(e.from)} · ${timeAgo(e.receivedAt)}</div>
          <div class="prop-preview">${esc(e.body.slice(0, 240))}</div>
        </div>
        <button class="btn btn-primary" data-email="${esc(e.id)}" ${p.busy ? "disabled" : ""}>${t("Generar Epic con IA")}</button>
      </div>`,
    )
    .join("");

  list.innerHTML = `${error}
    <div class="ms-filters">
      <span class="muted">${t("Bandeja")}: ${esc(p.status.folder)} · ${t("{n} sin procesar", { n: p.emails.length })}</span>
      <button id="prop-refresh" class="icon-btn" title="${t("Refrescar")}">⟳</button>
      <button id="prop-logout" class="btn">${t("Desconectar")}</button>
    </div>
    ${p.busy ? `<div class="loading">${t("Analizando el correo con IA…")}</div>` : ""}
    ${p.loading ? `<div class="loading">${t("Cargando…")}</div>` : rows || `<div class="empty">${t("No hay propuestas sin procesar.")}</div>`}`;

  $("#prop-refresh")?.addEventListener("click", refreshProposals);
  $("#prop-logout")?.addEventListener("click", disconnectMail);
  list.querySelectorAll("button[data-email]").forEach((btn) => btn.addEventListener("click", () => proposeFromEmail(btn.dataset.email)));
}

function renderMailLogin(p) {
  if (!p.login) {
    return `<div class="empty">
      <p>${t("Conecta la cuenta de Outlook donde llegan las propuestas.")}</p>
      <button id="prop-connect" class="btn btn-primary">${t("Conectar Outlook")}</button>
    </div>`;
  }
  return `<div class="empty">
    <p>${t("Abre esta página e introduce el código:")}</p>
    <p><a href="#" id="prop-login-url">${esc(p.login.url)}</a></p>
    <p class="prop-code">${esc(p.login.userCode)}</p>
    <p class="muted">${t("Esperando a que autorices…")}</p>
  </div>`;
}

function renderProposalDraft(p) {
  const d = p.draft;
  const tasks = d.tasks
    .map(
      (task, i) => `<label class="prop-task">
        <input type="checkbox" data-task="${i}" ${d.skip.has(i) ? "" : "checked"} />
        <div>
          <div class="prop-task-title">${esc(task.title)} <span class="muted">${esc(task.projectPath)}</span></div>
          <div class="prop-preview">${esc(task.description)}</div>
          ${task.checklist.length ? `<ul class="prop-check">${task.checklist.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        </div>
      </label>`,
    )
    .join("");

  return `<div class="lf-form">
    <div class="muted">${t("Borrador a partir de")}: ${esc(d.email.subject)} · ${esc(d.model || "")}</div>
    <label class="lf-field">${t("Título de la Epic")}<input id="prop-epic-title" type="text" value="${esc(d.epicTitle)}" /></label>
    <label class="lf-field">${t("Descripción de la Epic")}<textarea id="prop-epic-desc" rows="5">${esc(d.epicDescription)}</textarea></label>
    ${d.labels.length ? `<div class="muted">${t("Etiquetas")}: ${d.labels.map((l) => esc(l)).join(", ")}</div>` : ""}
    <div class="lf-field">${t("Tareas hijas")}</div>
    ${tasks || `<div class="empty">${t("La IA no ha propuesto ninguna tarea.")}</div>`}
    <div class="lf-actions">
      <button class="btn" id="prop-cancel">${t("← Volver")}</button>
      <button class="btn btn-primary" id="prop-create" ${p.busy ? "disabled" : ""}>${p.busy ? t("Creando…") : t("Crear en GitLab")}</button>
    </div>
  </div>`;
}

function wireDraftEvents(p) {
  $("#prop-cancel")?.addEventListener("click", () => {
    p.draft = null;
    renderProposals();
  });
  $("#prop-create")?.addEventListener("click", createFromDraft);
  $("#pr-list")
    .querySelectorAll("input[data-task]")
    .forEach((box) =>
      box.addEventListener("change", () => {
        const i = Number(box.dataset.task);
        if (box.checked) p.draft.skip.delete(i);
        else p.draft.skip.add(i);
      }),
    );
}
