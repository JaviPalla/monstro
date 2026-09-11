"use strict";

function renderChangesTab() {
  const files = state.files;
  if (!files) {
    $("#tab-body").innerHTML = `<div class="loading">${t("Cargando diff…")}</div>`;
    window.monstro.prFiles(detailRepo(), state.detailPR.number).then((loaded) => {
      state.files = loaded;
      if (state.detailTab === "changes") renderChangesTab();
    }).catch((err) => {
      $("#tab-body").innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
      notifySelftestOnce();
    });
    return;
  }

  const { map: anchored, orphans } = threadsByAnchor();
  const statusIcon = { added: "🟢", removed: "🔴", modified: "🟡", renamed: "🔵" };

  // Comentarios (hilos de GitHub) y borradores locales por fichero, para el índice lateral.
  const commentsPerFile = new Map();
  const unresolvedPerFile = new Map();
  for (const thread of state.conversation?.reviewThreads?.nodes || []) {
    const count = thread.comments?.nodes?.length || 0;
    commentsPerFile.set(thread.path, (commentsPerFile.get(thread.path) || 0) + count);
    if (!thread.isResolved) unresolvedPerFile.set(thread.path, (unresolvedPerFile.get(thread.path) || 0) + count);
  }
  const draftsPerFile = new Map();
  for (const draft of state.drafts) {
    if (draft.kind === "inline") draftsPerFile.set(draft.path, (draftsPerFile.get(draft.path) || 0) + 1);
  }

  const navRows = files
    .map((file, fi) => {
      const comments = commentsPerFile.get(file.filename) || 0;
      const unresolved = unresolvedPerFile.get(file.filename) || 0;
      const draftCount = draftsPerFile.get(file.filename) || 0;
      return `
      <button class="file-nav-row" data-target="diff-f${fi}" title="${esc(file.filename)}">
        <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
        <span class="file-nav-name">${esc(file.filename)}</span>
        ${comments ? `<span class="file-nav-badge badge-comments ${unresolved ? "" : "all-resolved"}" title="${unresolved ? t("{n} comentario(s) sin resolver", { n: unresolved }) : t("Todos los hilos resueltos")}">💬 ${comments}</span>` : ""}
        ${draftCount ? `<span class="file-nav-badge badge-drafts" title="${t("{n} borrador(es) local(es)", { n: draftCount })}">📝 ${draftCount}</span>` : ""}
      </button>`;
    })
    .join("");

  // Borradores de review que esperan en GitLab (p. ej. los de la skill mr-review-gitlab).
  const pendingTotal = state.conversation?.pendingDrafts || 0;
  const pendingInline = (state.conversation?.reviewThreads?.nodes || []).some((th) => th.isPendingDraft);
  const pendingBar = pendingTotal
    ? `<div class="gl-drafts-bar">📝 ${t("{n} comentarios de review pendientes de publicar en GitLab", { n: pendingTotal })}
        <span style="flex:1"></span>
        ${pendingInline ? `<button class="btn" id="gl-drafts-first">${t("Ir al primero")}</button>` : ""}
        <button class="btn btn-primary" id="gl-drafts-publish" title="${t("Publica todos tus borradores de esta MR en GitLab (pide confirmación)")}">${t("Publicar en GitLab")}</button>
      </div>`
    : "";

  // Qué ficheros tienes desplegados sobrevive a los repintados (editar, guardar, responder…): si no,
  // el comentario en el que estabas se queda dentro de un fichero plegado y pierdes el sitio.
  state.openFiles ??= new Set(files.slice(0, 6).map((f) => f.filename));

  $("#tab-body").innerHTML = `
    ${pendingBar}
    <div class="changes-layout">
      <nav class="file-nav">
        <div class="file-nav-h">${t("Ficheros")} (${files.length}) ·
          <span class="checks-success">+${files.reduce((s, f) => s + f.additions, 0)}</span>/<span class="checks-failure">−${files.reduce((s, f) => s + f.deletions, 0)}</span>
        </div>
        ${navRows}
      </nav>
      <div class="changes-body">
    ${files
      .map((file, fi) => {
        const orphanThreads = (orphans.get(file.filename) || []).map(threadBlock).join("");
        const comments = commentsPerFile.get(file.filename) || 0;
        return `
        <details class="diff-file" id="diff-f${fi}" data-file="${esc(file.filename)}" ${state.openFiles.has(file.filename) ? "open" : ""}>
          <summary>
            <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
            <span class="diff-path">${esc(file.previousFilename ? `${file.previousFilename} → ` : "")}${esc(file.filename)}</span>
            ${comments ? `<span class="file-nav-badge badge-comments">💬 ${comments}</span>` : ""}
            <span class="muted"><span class="checks-success">+${file.additions}</span> / <span class="checks-failure">−${file.deletions}</span></span>
          </summary>
          ${file.patch
            ? `<table class="diff-table">${parsePatch(file.patch).map((l) => diffLineRow(file, l, anchored)).join("")}</table>`
            : `<p class="muted" style="padding:10px 14px">${t("Sin diff disponible (binario o demasiado grande).")}</p>`}
          ${orphanThreads ? `<div class="orphan-threads"><div class="section-h">${t("Hilos en versiones anteriores")}</div>${orphanThreads}</div>` : ""}
        </details>`;
      })
      .join("")}
      </div>
    </div>
    <div class="comment-nav" id="comment-nav">
      <button class="btn" id="cn-prev" title="${t("Comentario anterior")}">↑</button>
      <span class="comment-nav-count" id="cn-count"></span>
      <button class="btn" id="cn-next" title="${t("Comentario siguiente")}">↓</button>
    </div>`;

  // índice lateral: saltar al fichero (abriendo su diff)
  $("#tab-body").querySelectorAll(".file-nav-row").forEach((row) =>
    row.addEventListener("click", () => {
      const target = document.getElementById(row.dataset.target);
      if (!target) return;
      target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#tab-body").querySelectorAll(".file-nav-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
    }),
  );

  // comentar en línea
  $("#tab-body").querySelectorAll(".add-comment").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const tr = btn.closest("tr");
      openInlineComposer(tr);
    }),
  );
  // responder hilos
  $("#tab-body").querySelectorAll("[data-reply]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ta = btn.parentElement.querySelector("textarea");
      const body = ta.value.trim();
      if (!body || !btn.dataset.reply) return;
      btn.disabled = true;
      try {
        await window.monstro.replyThread(detailRepo(), state.detailPR.number, Number(btn.dataset.reply), body);
        toast(t("Respuesta publicada"), "ok");
        state.conversation = await window.monstro.prConversation(detailRepo(), state.detailPR.number);
        renderDetailInPlace();
      } catch (err) {
        toast(t("No se pudo responder: {err}", { err: String(err.message || err) }), "err");
        btn.disabled = false;
      }
    }),
  );
  // resolver / reabrir hilos
  $("#tab-body").querySelectorAll(".thread-resolve").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const resolved = btn.dataset.resolved === "true";
      btn.disabled = true;
      try {
        await window.monstro.resolveThread(btn.dataset.resolveId, resolved);
        toast(resolved ? t("Conversación resuelta ✓") : t("Conversación reabierta"), "ok");
        state.conversation = await window.monstro.prConversation(detailRepo(), state.detailPR.number);
        renderDetailInPlace();
      } catch (err) {
        toast(t("No se pudo {action}: {err}", { action: resolved ? t("resolver") : t("reabrir"), err: String(err.message || err) }), "err");
        btn.disabled = false;
      }
    }),
  );
  wireExternalLinks();
  wireDraftCards($("#tab-body"));
  wirePendingDraftEdits($("#tab-body"));
  const navTotal = commentNavItems().length;
  if (navTotal) {
    const last = state.commentNav;
    $("#cn-count").textContent = last && last.index < navTotal ? `${last.index + 1}/${navTotal}` : String(navTotal);
    $("#cn-prev").addEventListener("click", () => jumpToComment(-1));
    $("#cn-next").addEventListener("click", () => jumpToComment(1));
  } else {
    $("#comment-nav").remove();
  }
  const firstPending = () => {
    const el = $("#tab-body").querySelector(".thread.pending-draft");
    if (!el) return;
    const file = el.closest("details");
    if (file) file.open = true;
    // A mano sobre el panel (su scroller): scrollIntoView también desplaza la ventana y se come la topbar.
    detailPane.scrollTop += el.getBoundingClientRect().top - detailPane.getBoundingClientRect().top - 80;
  };
  $("#gl-drafts-first")?.addEventListener("click", firstPending);
  $("#gl-drafts-publish")?.addEventListener("click", publishGitlabDrafts);
  // Abierta desde una sesión de review del panel de sesiones: directo al primer borrador pendiente.
  if (state.focusPendingDrafts) {
    state.focusPendingDrafts = false;
    firstPending();
  }
  notifySelftestOnce();
}

// Publica de golpe todos tus borradores de review de GitLab (bulk_publish), sin pasar por el
// navegador. Es irreversible y lo ve todo el equipo: siempre tras un clic y una confirmación.
async function publishGitlabDrafts() {
  const n = state.conversation?.pendingDrafts || 0;
  if (!n || !confirm(t("¿Publicar los {n} comentarios en GitLab? Dejan de ser borradores y los verá todo el equipo.", { n }))) return;
  const btn = $("#gl-drafts-publish");
  if (btn) btn.disabled = true;
  try {
    await window.monstro.publishDraftNotes(detailRepo(), state.detailPR.number);
    state.conversation = await window.monstro.prConversation(detailRepo(), state.detailPR.number);
    toast(t("{n} comentarios publicados en GitLab ✓", { n }), "ok");
    renderDetailInPlace();
  } catch (err) {
    toast(t("No se pudieron publicar los comentarios: {err}", { err: String(err.message || err) }), "err");
    if (btn) btn.disabled = false;
  }
}

// Todo lo comentado del diff, en orden de lectura: hilos, borradores de GitLab y borradores locales.
function commentNavItems() {
  return [...$("#tab-body").querySelectorAll(".changes-body .thread, .changes-body .draft-card")];
}

// Flechas ↑↓: salta al comentario anterior/siguiente desplegando su fichero. Si has movido la
// pantalla desde el último salto sigue desde lo que estás viendo; si no, va al siguiente de la
// lista (cerca del final la página ya no baja y la posición no serviría para avanzar).
function jumpToComment(direction) {
  const items = commentNavItems();
  if (!items.length) return;
  const viewTop = detailPane.getBoundingClientRect().top + 80; // bajo la cabecera, como "Ir al primero"
  // Lo que está dentro de un fichero plegado no tiene caja: cuenta la de su cabecera.
  const top = (el) => (el.closest("details:not([open])") || el).getBoundingClientRect().top - viewTop;
  const last = state.commentNav;
  let index = last && last.scrollTop === detailPane.scrollTop
    ? last.index + direction
    : direction > 0 ? items.findIndex((el) => top(el) > 1) : items.findLastIndex((el) => top(el) < -1);
  if (index < 0 || index >= items.length) index = direction > 0 ? 0 : items.length - 1;
  const el = items[index];
  const file = el.closest("details");
  if (file) file.open = true;
  detailPane.scrollTop += el.getBoundingClientRect().top - viewTop;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
  state.commentNav = { index, scrollTop: detailPane.scrollTop };
  $("#cn-count").textContent = `${index + 1}/${items.length}`;
}

function openInlineComposer(tr) {
  document.querySelectorAll(".inline-composer-row").forEach((row) => row.remove());
  const { path, line, side } = tr.dataset;
  if (!line) return;
  const row = document.createElement("tr");
  row.className = "inline-composer-row";
  row.innerHTML = `
    <td colspan="3">
      <div class="composer inline">
        <div class="muted" style="margin-bottom:6px">📝 ${t("Borrador en")} <code>${esc(path)}</code> ${t("línea")} ${esc(line)} (${side === "LEFT" ? t("versión anterior") : t("versión nueva")}) — ${t("no se publica hasta que tú lo digas")}</div>
        <textarea rows="3" placeholder="${t("Tu comentario…")}"></textarea>
        <div class="composer-actions">
          ${severityPicker({})}
          <span style="flex:1"></span>
          <button class="btn cancel">${t("Cancelar")}</button>
          <button class="btn btn-accent send">📝 ${t("Guardar borrador")}</button>
        </div>
      </div>
    </td>`;
  tr.after(row);
  row.querySelector("textarea").focus();
  row.querySelector(".cancel").addEventListener("click", () => row.remove());
  row.querySelector(".send").addEventListener("click", async () => {
    const body = row.querySelector("textarea").value.trim();
    if (!body) return;
    await addDraft({ kind: "inline", path, side, line: Number(line), body, severity: row.querySelector(".sev-select").value });
    renderDetail();
  });
}

function wireExternalLinks() {
  detailContent.querySelectorAll(".pr-body a, [data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      const url = a.dataset.ext || a.href;
      if (url?.startsWith("http")) window.monstro.openExternal(url);
    }),
  );
}

/* ============ acciones PR ============ */
