"use strict";

/* ============ prioridad: burbujas de color ============ */
// El emoji va SIEMPRE al principio del comentario publicado (GitLab no renderiza nuestro CSS),
// la píldora de color es lo que se ve dentro de Monstro.
const SEVERITIES = {
  blocker: { dot: "🔴", label: () => t("Bloqueante") },
  important: { dot: "🟠", label: () => t("Importante") },
  minor: { dot: "🟡", label: () => t("Mejorable") },
  nit: { dot: "🟢", label: () => t("Menor") },
};
const DEFAULT_SEVERITY = "minor";

function severityOf(draft) {
  return SEVERITIES[draft?.severity] ? draft.severity : DEFAULT_SEVERITY;
}

function severityBubble(draft) {
  const key = severityOf(draft);
  return `<span class="sev sev-${key}" title="${t("Prioridad")}">${icon("circle", "fill")} ${SEVERITIES[key].label()}</span>`;
}

function severityPicker(draft) {
  const current = severityOf(draft);
  return `<select class="sev-select">${Object.entries(SEVERITIES)
    .map(([key, s]) => `<option value="${key}" ${key === current ? "selected" : ""}>${s.label()}</option>`)
    .join("")}</select>`;
}

/** Cuerpo tal y como se publica: con la burbuja delante para que la prioridad se vea en GitLab. */
function publishBody(draft) {
  const { dot, label } = SEVERITIES[severityOf(draft)];
  return `${dot} **${label()}** — ${draft.body}`;
}

function draftsKey() {
  return `${detailRepo()}#${state.selected}`;
}

async function saveDrafts() {
  state.drafts = await window.monstro.draftsSave(draftsKey(), state.drafts);
  state.draftKeys = new Set(await window.monstro.draftsKeys());
}

async function addDraft(draft) {
  const id = globalThis.crypto?.randomUUID?.() || `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.drafts.push({ id, createdAt: new Date().toISOString(), ...draft });
  await saveDrafts();
  toast(t("Borrador guardado (solo en tu Mac)"), "ok");
}

async function removeDraft(id) {
  state.drafts = state.drafts.filter((d) => d.id !== id);
  await saveDrafts();
}

function draftCard(draft) {
  const where = draft.kind === "inline"
    ? `<code>${esc(draft.path)}</code> · ${t("línea {line} ({side})", { line: draft.line, side: draft.side === "LEFT" ? t("anterior") : t("nueva") })}`
    : t("comentario general");
  if (state.editingDraftId === draft.id) {
    return `
      <div class="draft-card editing" data-draft="${draft.id}">
        <div class="draft-head">${icon("pencil")} ${t("EDITANDO")} <span class="muted">· ${where}</span></div>
        <textarea class="draft-editor" rows="5">${esc(draft.body)}</textarea>
        <div class="composer-actions">
          ${severityPicker(draft)}
          <span style="flex:1"></span>
          <button class="btn draft-edit-cancel">${t("Cancelar")}</button>
          <button class="btn btn-accent draft-edit-save">${t("Guardar")}</button>
        </div>
      </div>`;
  }
  return `
    <div class="draft-card" data-draft="${draft.id}">
      <div class="draft-head">${severityBubble(draft)} ${icon("file-pen-line")} ${t("BORRADOR")} <span class="muted">· ${where}</span>
        <button class="draft-edit" title="${t("Editar borrador")}">${icon("pencil")}</button>
        <button class="draft-pub" title="${t("Publicar solo este borrador en GitHub")}">${icon("send")} ${t("Publicar")}</button>
        <button class="draft-del" title="${t("Eliminar borrador")}">${icon("trash-2")}</button>
      </div>
      <div class="draft-body">${esc(draft.body)}</div>
    </div>`;
}

function wireDraftCards(container) {
  container.querySelectorAll(".draft-card .draft-del").forEach((btn) =>
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await removeDraft(btn.closest(".draft-card").dataset.draft);
      renderDetailInPlace();
    }),
  );
  container.querySelectorAll(".draft-card .draft-pub").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const draft = state.drafts.find((d) => d.id === btn.closest(".draft-card").dataset.draft);
      if (draft) confirmPublishSingle(draft);
    }),
  );
  container.querySelectorAll(".draft-card .draft-edit").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingDraftId = btn.closest(".draft-card").dataset.draft;
      renderDetailInPlace();
      detailContent.querySelector(".draft-card.editing .draft-editor")?.focus({ preventScroll: true });
    }),
  );
  container.querySelectorAll(".draft-card.editing").forEach((card) => {
    const id = card.dataset.draft;
    card.querySelector(".draft-edit-cancel").addEventListener("click", () => {
      state.editingDraftId = null;
      renderDetailInPlace();
    });
    card.querySelector(".draft-edit-save").addEventListener("click", async () => {
      const body = card.querySelector(".draft-editor").value.trim();
      const draft = state.drafts.find((d) => d.id === id);
      if (draft && body) {
        draft.body = body;
        draft.severity = card.querySelector(".sev-select").value;
        await saveDrafts();
        toast(t("Borrador actualizado"), "ok");
      }
      state.editingDraftId = null;
      renderDetailInPlace();
    });
  });
}

function confirmPublishSingle(draft) {
  const root = $("#modal-root");
  const where = draft.kind === "inline" ? `${draft.path}:${draft.line}` : t("comentario general");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${icon("send")} ${t("Publicar este borrador")}</h3>
        <p class="muted">${esc(where)} — ${t("se publica como comentario (sin veredicto). El resto de borradores no se tocan.")}</p>
        <div class="draft-card" style="max-height:180px;overflow-y:auto"><div class="draft-body">${esc(publishBody(draft))}</div></div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Publicar en GitHub")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      state.conversation = await window.monstro.prConversation(detailRepo(), state.selected);
      await window.monstro.submitReview(detailRepo(), state.selected, {
        commitId: state.conversation.headRefOid,
        event: "COMMENT",
        body: draft.kind === "general" ? publishBody(draft) : undefined,
        comments: draft.kind === "inline" ? [{ ...draft, body: publishBody(draft) }] : [],
      });
      await removeDraft(draft.id);
      toast(t("Borrador publicado"), "ok");
      state.conversation = await window.monstro.prConversation(detailRepo(), state.selected);
      renderDetail();
    } catch (err) {
      toast(t("No se pudo publicar (el borrador sigue guardado): {err}", { err: String(err.message || err) }), "err");
    }
  });
}

function draftsBar() {
  if (!state.drafts.length) return "";
  return `
    <div class="drafts-bar">
      <button class="drafts-count" id="drafts-view" title="${t("Ver todos los borradores")}">${icon("file-pen-line")} <b>${state.drafts.length}</b> ${state.drafts.length > 1 ? t("borradores sin publicar") : t("borrador sin publicar")}</button>
      <button class="icon-btn" id="drafts-prev" title="${t("Borrador anterior")}">${icon("arrow-up")}</button>
      <button class="icon-btn" id="drafts-next" title="${t("Borrador siguiente")}">${icon("arrow-down")}</button>
      <span style="flex:1"></span>
      <button class="btn" id="drafts-discard">${t("Descartar todos")}</button>
      <button class="btn btn-primary" id="drafts-publish">${t("Publicar…")}</button>
    </div>`;
}

function wireDraftsBar() {
  $("#drafts-publish")?.addEventListener("click", openPublishModal);
  $("#drafts-view")?.addEventListener("click", openDraftsViewer);
  $("#drafts-prev")?.addEventListener("click", () => navigateDrafts(-1));
  $("#drafts-next")?.addEventListener("click", () => navigateDrafts(1));
  $("#drafts-discard")?.addEventListener("click", async () => {
    state.drafts = [];
    await saveDrafts();
    toast(t("Borradores descartados"), "");
    renderDetail();
  });
}

/* ============ navegación y visor de borradores ============ */
// Orden de lectura y de navegación ↑↓: primero lo grave, luego por fichero y línea. El general
// (el resumen) va al final.
const SEVERITY_RANK = { blocker: 0, important: 1, minor: 2, nit: 3 };

function orderedDrafts() {
  const fileOrder = new Map((state.files || []).map((f, i) => [f.filename, i]));
  return [...state.drafts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "inline" ? -1 : 1;
    const bySeverity = SEVERITY_RANK[severityOf(a)] - SEVERITY_RANK[severityOf(b)];
    if (bySeverity) return bySeverity;
    if (a.kind === "inline") {
      const byFile = (fileOrder.get(a.path) ?? 999) - (fileOrder.get(b.path) ?? 999);
      if (byFile) return byFile;
      return (a.line || 0) - (b.line || 0);
    }
    return 0;
  });
}

async function scrollToDraft(id) {
  const draft = state.drafts.find((d) => d.id === id);
  if (!draft) return;
  const wantedTab = draft.kind === "inline" ? "changes" : "conv";
  if (state.detailTab !== wantedTab) {
    state.detailTab = wantedTab;
    renderDetail();
  }
  // el tab de cambios puede estar cargando el diff: reintenta hasta encontrar la tarjeta
  for (let attempt = 0; attempt < 25; attempt++) {
    const node = detailContent.querySelector(`[data-draft="${CSS.escape(id)}"]`);
    if (node) {
      const fold = node.closest("details");
      if (fold && !fold.open) fold.open = true;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1600);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function navigateDrafts(direction) {
  const drafts = orderedDrafts();
  if (!drafts.length) return;
  state.draftNavIndex = (state.draftNavIndex + direction + drafts.length) % drafts.length;
  const target = drafts[state.draftNavIndex];
  toast(t("Borrador {pos} de {total}", { pos: state.draftNavIndex + 1, total: drafts.length }), "");
  scrollToDraft(target.id);
}

function openDraftsViewer() {
  const root = $("#modal-root");
  const drafts = orderedDrafts();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-wide">
        <h3>${icon("file-pen-line")} ${t("Se publicarían {count} comentarios en #{num}", { num: state.selected, count: drafts.length })}</h3>
        <p class="muted">${t("Revísalos y edítalos a tu gusto. Nada sale de tu Mac hasta que pulses Publicar.")}</p>
        <div class="drafts-viewer">
          ${drafts.map((d) => {
            const where = `${severityBubble(d)} ${icon("file-pen-line")} ${d.kind === "inline"
              ? `<code>${esc(d.path)}</code>:${d.line} <span class="muted">(${d.side === "LEFT" ? t("anterior") : t("nueva")})</span>`
              : `<span class="muted">${t("comentario general")}</span>`}`;
            if (state.editingDraftId === d.id) {
              return `
                <div class="viewer-row editing" data-id="${d.id}">
                  <div class="viewer-where">${where}</div>
                  <textarea class="draft-editor viewer-editor" rows="8">${esc(d.body)}</textarea>
                  <div class="viewer-actions">
                    ${severityPicker(d)}
                    <button class="btn btn-accent viewer-save" data-id="${d.id}">${t("Guardar")}</button>
                    <button class="btn viewer-cancel">${t("Cancelar")}</button>
                  </div>
                </div>`;
            }
            return `
            <div class="viewer-row" data-id="${d.id}">
              <div class="viewer-where">${where}</div>
              <div class="viewer-body">${esc(d.body)}</div>
              <div class="viewer-actions">
                <button class="btn viewer-go" data-id="${d.id}">${t("Ir")} ${icon("arrow-right")}</button>
                <button class="btn viewer-edit" data-id="${d.id}" title="${t("Editar borrador")}">${icon("pencil")}</button>
                <button class="btn viewer-pub" data-id="${d.id}" title="${t("Publicar solo este borrador")}">${t("Publicar")}</button>
                <button class="btn viewer-del" data-id="${d.id}" title="${t("Eliminar borrador")}">${icon("trash-2")}</button>
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cerrar")}</button>
          <button class="btn" id="viewer-discard">${t("Descartar todos")}</button>
          <button class="btn btn-primary" id="viewer-publish">${t("Publicar…")}</button>
        </div>
      </div>
    </div>`;
  const close = () => {
    state.editingDraftId = null;
    root.innerHTML = "";
  };
  $("#modal-cancel").addEventListener("click", close);
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#viewer-publish").addEventListener("click", () => {
    close();
    openPublishModal();
  });
  $("#viewer-discard").addEventListener("click", async () => {
    close();
    state.drafts = [];
    await saveDrafts();
    toast(t("Borradores descartados"), "");
    renderDetail();
  });
  root.querySelectorAll(".viewer-go").forEach((btn) =>
    btn.addEventListener("click", () => {
      close();
      scrollToDraft(btn.dataset.id);
    }),
  );
  root.querySelectorAll(".viewer-pub").forEach((btn) =>
    btn.addEventListener("click", () => {
      const draft = state.drafts.find((d) => d.id === btn.dataset.id);
      close();
      if (draft) confirmPublishSingle(draft);
    }),
  );
  // Editar sin salir del visor: lo que ves es lo que se publicaría, así que se retoca aquí mismo.
  root.querySelectorAll(".viewer-edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.editingDraftId = btn.dataset.id;
      openDraftsViewer();
      root.querySelector(".viewer-editor")?.focus();
    }),
  );
  root.querySelector(".viewer-cancel")?.addEventListener("click", () => {
    state.editingDraftId = null;
    openDraftsViewer();
  });
  root.querySelector(".viewer-save")?.addEventListener("click", async (event) => {
    const row = event.target.closest(".viewer-row");
    const draft = state.drafts.find((d) => d.id === row.dataset.id);
    const body = row.querySelector(".viewer-editor").value.trim();
    if (draft && body) {
      draft.body = body;
      draft.severity = row.querySelector(".sev-select").value;
      await saveDrafts();
      toast(t("Borrador actualizado"), "ok");
    }
    state.editingDraftId = null;
    openDraftsViewer();
    renderDetail();
  });
  root.querySelectorAll(".viewer-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await removeDraft(btn.dataset.id);
      renderDetail();
      if (state.drafts.length) openDraftsViewer();
      else close();
    }),
  );
}

function openPublishModal() {
  const root = $("#modal-root");
  const inline = state.drafts.filter((d) => d.kind === "inline");
  const general = state.drafts.filter((d) => d.kind === "general");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${state.drafts.length > 1 ? t("Publicar {n} borradores como review", { n: state.drafts.length }) : t("Publicar {n} borrador como review", { n: state.drafts.length })}</h3>
        <p class="muted">${t("{inline} en línea · {general}", { inline: inline.length, general: general.length === 1 ? t("{n} general", { n: general.length }) : t("{n} generales", { n: general.length }) })} — ${t("se publican en una sola review.")}</p>
        <div class="verdict">
          <label><input type="radio" name="verdict" value="COMMENT" checked /> ${icon("message-square")} ${t("Comentar")}</label>
          <label><input type="radio" name="verdict" value="APPROVE" /> ${icon("circle-check")} ${t("Aprobar")}</label>
          <label><input type="radio" name="verdict" value="REQUEST_CHANGES" /> ${icon("file-diff")} ${t("Pedir cambios")}</label>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Publicar en GitHub")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const event = root.querySelector('input[name="verdict"]:checked').value;
    root.innerHTML = "";
    await publishDrafts(event);
  });
}

async function publishDrafts(event) {
  const pr = state.detailPR;
  try {
    // headRefOid fresco: si la rama avanzó, los comentarios se anclan al último commit
    state.conversation = await window.monstro.prConversation(detailRepo(), pr.number);
    const inline = state.drafts.filter((d) => d.kind === "inline");
    const general = state.drafts.filter((d) => d.kind === "general");
    await window.monstro.submitReview(detailRepo(), pr.number, {
      commitId: state.conversation.headRefOid,
      event,
      body: general.map(publishBody).join("\n\n---\n\n") || undefined,
      comments: inline.map((d) => ({ ...d, body: publishBody(d) })),
    });
    state.drafts = [];
    await saveDrafts();
    toast(t("Review publicada ({verdict})", { verdict: event === "APPROVE" ? t("aprobada") : event === "REQUEST_CHANGES" ? t("cambios pedidos") : t("comentarios") }), "ok");
    state.conversation = await window.monstro.prConversation(detailRepo(), pr.number);
    renderDetail();
  } catch (err) {
    toast(t("No se pudo publicar (tus borradores siguen guardados): {err}", { err: String(err.message || err) }), "err");
  }
}

/* ============ chips ============ */
