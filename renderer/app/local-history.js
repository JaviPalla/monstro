// Historial de tareas locales: tarjetas, badges de MR/issue y panel de detalle.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
const KIND_LABEL = { tarea: t("Tarea"), epic: "Epic", vincular: t("Vinculación") };

// Enlace-pill tipado (Issue/Epic/MR/Commit) a GitLab. Reutilizado por la lista y el detalle.
const lhPill = (type, url, label) => `<a href="${esc(url)}" class="lh-pill lh-pill-${type}" data-ext>${esc(label)}</a>`;
// Badges de estado en vivo (#4b): MR merged/closed; issue cerrada + etiquetas importantes.
const IMPORTANT_LABEL_RE = /finished|pending check|needs fixing/i;
const lhMrBadge = (pp, num) => {
  const s = state.local.historyStatus[`mr:${pp}#${num}`];
  return s?.merged ? `<span class="lh-badge merged">merged</span>` : s?.state === "closed" ? `<span class="lh-badge closed">closed</span>` : "";
};
const lhIssueBadges = (pp, iid) => {
  const s = state.local.historyStatus[`issue:${pp}#${iid}`];
  if (!s) return "";
  const out = s.closed ? [`<span class="lh-badge closed">${esc(t("cerrada"))}</span>`] : [];
  for (const lbl of s.labels || []) if (IMPORTANT_LABEL_RE.test(lbl)) out.push(`<span class="lh-badge lbl">${esc(lbl)}</span>`);
  return out.join("");
};
const lhDate = (ts) => { try { return new Date(ts).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" }); } catch { return ts || ""; } };
// ¿Algún paso o proyecto falló? (para el aviso ⚠ y que no pase desapercibido un push silencioso).
function entryHasWarning(e) {
  const stepBad = (steps) => (steps || []).some((s) => s && s.ok === false);
  if (e.kind === "tarea") return stepBad(e.steps);
  return (e.results || []).some((r) => !r.ok || stepBad(r.steps));
}

function renderLocalHistory() {
  if (state.local.historyDetail) return renderLocalHistoryDetail();
  const entries = state.local.history || [];
  const head = `
    <div class="local-head">
      <h2>${t("Histórico")}</h2>
      <p class="local-desc">${t("Trabajos creados desde Trabajo local, con los enlaces de GitLab de cada item. Pulsa una tarjeta para ver el detalle y el log de pasos.")}</p>
    </div>`;
  if (!entries.length) {
    list.innerHTML = head + `<div class="local-empty"><p>${t("Aún no has creado ninguna tarea desde aquí.")}</p></div>`;
    notifySelftestOnce();
    return;
  }
  const projRow = (r, withTask) =>
    r.ok
      ? `<div class="lh-proj"><span class="lh-proj-name">${projectIconHtml(r.projectPath)}${esc(projectMeta(r.projectPath).name)}</span><span class="lh-proj-pills">${withTask && r.task ? lhPill("issue", r.task.url, t("Tarea #{n}", { n: r.task.iid })) + lhIssueBadges(r.projectPath, r.task.iid) : ""}${lhPill("mr", r.mr.url, `MR !${r.mr.number}`)}${lhMrBadge(r.projectPath, r.mr.number)}${r.commit ? lhPill("commit", r.commit.url, r.commit.sha.slice(0, 8)) : ""}</span></div>`
      : `<div class="lh-proj err"><span class="lh-proj-name">${esc(r.projectPath)}</span><span class="local-err">⚠ ${esc(r.error)}</span></div>`;
  const cards = entries
    .map((e) => {
      let items = "";
      if (e.kind === "tarea") {
        items = `<div class="lh-pills">${lhPill("issue", e.issue.url, `Issue #${e.issue.iid}`)}${lhIssueBadges(e.issue.projectPath, e.issue.iid)}${lhPill("mr", e.mr.url, `MR !${e.mr.number}`)}${lhMrBadge(e.mr.projectPath, e.mr.number)}${e.commit ? lhPill("commit", e.commit.url, `Commit ${e.commit.sha.slice(0, 8)}`) : ""}</div>`;
        if (e.projectPath) items = `<div class="lh-sub">${projectIconHtml(e.projectPath)}${esc(projectMeta(e.projectPath).name)}</div>` + items;
      } else if (e.kind === "epic") {
        items = `<div class="lh-pills">${lhPill("epic", e.epic.url, `Epic #${e.epic.iid}`)}${lhIssueBadges(e.epic.projectPath, e.epic.iid)}</div>${(e.results || []).map((r) => projRow(r, true)).join("")}`;
      } else {
        items = `<div class="lh-pills">${lhPill(e.issue.isEpic ? "epic" : "issue", e.issue.url, `${e.issue.isEpic ? "Epic" : "Issue"} ${e.issue.projectPath}#${e.issue.iid}`)}${lhIssueBadges(e.issue.projectPath, e.issue.iid)}</div>${(e.results || []).map((r) => projRow(r, false)).join("")}`;
      }
      const warn = entryHasWarning(e) ? `<span class="lh-warn" title="${esc(t("Algún paso no se completó — abre el detalle"))}">⚠</span>` : "";
      return `
        <div class="lh-card lh-k-${esc(e.kind)}">
          <div class="lh-head">
            <span class="lh-kind lh-${esc(e.kind)}">${KIND_LABEL[e.kind] || esc(e.kind)}</span>
            <span class="lh-title">${esc(e.title || t("(sin título)"))}</span>
            ${warn}
            <time class="lh-date">${esc(lhDate(e.ts))}</time>
            <button class="lh-detail" data-id="${esc(e.id)}">${t("Detalle →")}</button>
            <button class="lh-del" data-id="${esc(e.id)}" title="${esc(t("Quitar del histórico"))}" aria-label="${esc(t("Quitar del histórico"))}">✕</button>
          </div>
          <div class="lh-items">${items}</div>
        </div>`;
    })
    .join("");
  list.innerHTML = head + `<div class="lh-toolbar"><span class="muted">${entries.length === 1 ? t("{n} trabajo", { n: entries.length }) : t("{n} trabajos", { n: entries.length })}</span><button class="btn local-change" id="lh-clear">${t("Vaciar histórico")}</button></div><div class="lh-list">${cards}</div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  list.querySelectorAll(".lh-detail").forEach((b) => b.addEventListener("click", () => { state.local.historyDetail = (state.local.history || []).find((x) => x.id === b.dataset.id) || null; renderLocal(); }));
  list.querySelectorAll(".lh-del").forEach((b) => b.addEventListener("click", async () => { state.local.history = await window.monstro.localHistoryRemove(b.dataset.id); renderLocal(); }));
  $("#lh-clear")?.addEventListener("click", async () => { state.local.history = await window.monstro.localHistoryClear(); renderLocal(); });
  notifySelftestOnce();
}

// Vista de detalle de una entrada del histórico: items con sus enlaces + el LOG DE PASOS (commit,
// push, rama feature…) por proyecto, para enterarse si algo no se completó (p.ej. un push silencioso).
function renderLocalHistoryDetail() {
  const e = state.local.historyDetail;
  const stepsHtml = (steps) =>
    (steps || []).length
      ? `<ul class="lh-steps">${steps.map((s) => `<li class="${s.ok === false ? "bad" : "good"}">${s.ok === false ? "✕" : "✓"} ${esc(s.text)}</li>`).join("")}</ul>`
      : `<p class="muted lh-nosteps">${t("Sin pasos locales registrados.")}</p>`;
  let body = "";
  let primaryMr = null;
  if (e.kind === "tarea") {
    primaryMr = e.mr;
    body = `
      <div class="lh-d-block">
        <div class="lh-sub">${projectIconHtml(e.projectPath)}${esc(projectMeta(e.projectPath).name)}</div>
        <div class="lh-pills">${lhPill("issue", e.issue.url, `Issue #${e.issue.iid}`)}${lhPill("mr", e.mr.url, `MR !${e.mr.number}`)}${e.commit ? lhPill("commit", e.commit.url, `Commit ${e.commit.sha.slice(0, 8)}`) : ""}</div>
        ${stepsHtml(e.steps)}
      </div>`;
  } else {
    const top = e.kind === "epic"
      ? `<div class="lh-pills">${lhPill("epic", e.epic.url, `Epic #${e.epic.iid} · ${e.epic.title}`)}</div>`
      : `<div class="lh-pills">${lhPill(e.issue.isEpic ? "epic" : "issue", e.issue.url, `${e.issue.isEpic ? "Epic" : "Issue"} ${e.issue.projectPath}#${e.issue.iid} · ${e.issue.title}`)}</div>`;
    primaryMr = (e.results || []).find((r) => r.ok)?.mr || null;
    const blocks = (e.results || [])
      .map((r) => {
        const links = r.ok
          ? `<div class="lh-pills">${r.task ? lhPill("issue", r.task.url, t("Tarea #{n}", { n: r.task.iid })) : ""}${lhPill("mr", r.mr.url, `MR !${r.mr.number}`)}${r.commit ? lhPill("commit", r.commit.url, `Commit ${r.commit.sha.slice(0, 8)}`) : ""}</div>`
          : `<div class="local-err">⚠ ${esc(r.error)}</div>`;
        return `<div class="lh-d-block ${r.ok ? "" : "err"}"><div class="lh-sub">${projectIconHtml(r.projectPath)}${esc(projectMeta(r.projectPath).name)}</div>${links}${stepsHtml(r.steps)}</div>`;
      })
      .join("");
    body = top + blocks;
  }
  list.innerHTML = `
    <div class="local-head">
      <h2>${KIND_LABEL[e.kind] || esc(e.kind)} · ${esc(e.title || "")}</h2>
      <p class="local-desc">${esc(lhDate(e.ts))}</p>
    </div>
    <div class="lh-detail-body">${body}</div>
    <div class="lf-actions" style="margin:0 20px 28px">
      <button class="btn" id="lhd-back">${t("← Volver al histórico")}</button>
      ${primaryMr ? `<button class="btn btn-accent" id="lhd-openmr">${t("Ver MR en Monstro")}</button>` : ""}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  $("#lhd-back").addEventListener("click", () => { state.local.historyDetail = null; renderLocal(); });
  if (primaryMr) $("#lhd-openmr").addEventListener("click", () => { state.local.historyDetail = null; openLocalMrInMonstro(primaryMr); });
  notifySelftestOnce();
}

