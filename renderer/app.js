"use strict";

/* ============ estado ============ */
const state = {
  config: null,
  me: null,
  repo: null,
  bucket: "open",
  prs: [],            // PRs del bucket base actual (OPEN o MERGED/CLOSED)
  openPrs: [],        // cache de OPEN para counts de sidebar
  selected: null,     // número de PR seleccionado
  search: "",
  loading: false,
  pollTimer: null,
  selftestNotified: false,
};

const IS_SELFTEST = new URLSearchParams(location.search).get("selftest") === "1";

const $ = (sel) => document.querySelector(sel);
const list = $("#pr-list");
const detailPane = $("#detail-pane");
const detailContent = $("#detail-content");

/* ============ utilidades ============ */
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function timeAgo(iso) {
  const seconds = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    [31536000, "a"], [2592000, "mes"], [604800, "sem"], [86400, "d"], [3600, "h"], [60, "min"],
  ];
  for (const [div, label] of units) {
    if (seconds >= div) {
      const v = Math.floor(seconds / div);
      return `hace ${v} ${label}${label === "mes" && v > 1 ? "es" : ""}`;
    }
  }
  return "ahora";
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function notifySelftestOnce() {
  if (!state.selftestNotified) {
    state.selftestNotified = true;
    window.pulpo.selftestRenderComplete();
  }
}

/* ============ render: chips ============ */
function stateChip(pr) {
  if (pr.state === "MERGED") return `<span class="chip chip-merged">Fusionada</span>`;
  if (pr.state === "CLOSED") return `<span class="chip chip-closed">Cerrada</span>`;
  if (pr.isDraft) return `<span class="chip chip-draft">Borrador</span>`;
  return `<span class="chip chip-open">Abierta</span>`;
}

function reviewChip(pr) {
  if (pr.state !== "OPEN") return "";
  switch (pr.reviewDecision) {
    case "APPROVED": return `<span class="chip chip-approved">✓ Aprobada</span>`;
    case "CHANGES_REQUESTED": return `<span class="chip chip-changes">± Cambios pedidos</span>`;
    case "REVIEW_REQUIRED": return `<span class="chip chip-review">Falta revisión</span>`;
    default: return "";
  }
}

function mergeStateChip(pr) {
  if (pr.state !== "OPEN") return "";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    return `<span class="chip chip-conflict">Conflictos</span>`;
  if (pr.mergeStateStatus === "BEHIND")
    return `<span class="chip chip-behind">Rama atrasada</span>`;
  return "";
}

function checksIcon(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return "";
  const map = {
    SUCCESS: ["✓", "checks-success", "Checks en verde"],
    FAILURE: ["✗", "checks-failure", "Checks fallando"],
    ERROR: ["✗", "checks-failure", "Checks con error"],
    PENDING: ["●", "checks-pending", "Checks en curso"],
    EXPECTED: ["●", "checks-pending", "Checks esperados"],
  };
  const [icon, cls, title] = map[rollup.state] || ["", "", ""];
  return icon ? `<span class="checks ${cls}" title="${title}">${icon}</span>` : "";
}

function labelPills(pr) {
  return (pr.labels?.nodes || [])
    .map((l) => {
      const color = `#${l.color}`;
      return `<span class="label-pill" style="background:${color}22;color:${color}">${esc(l.name)}</span>`;
    })
    .join("");
}

/* ============ render: lista ============ */
function bucketFilter(prs) {
  const login = state.me?.login;
  switch (state.bucket) {
    case "mine": return prs.filter((p) => p.author?.login === login);
    case "review":
      return prs.filter((p) =>
        (p.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === login),
      );
    case "draft": return prs.filter((p) => p.isDraft);
    default: return prs;
  }
}

function searchFilter(prs) {
  const q = state.search.trim().toLowerCase();
  if (!q) return prs;
  return prs.filter((p) =>
    [p.title, p.headRefName, p.baseRefName, p.author?.login, String(p.number)]
      .join(" ").toLowerCase().includes(q),
  );
}

function renderCounts() {
  const open = state.openPrs;
  const login = state.me?.login;
  $("#count-open").textContent = open.length || "";
  $("#count-mine").textContent = open.filter((p) => p.author?.login === login).length || "";
  $("#count-review").textContent =
    open.filter((p) => (p.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === login)).length || "";
  $("#count-draft").textContent = open.filter((p) => p.isDraft).length || "";
}

function renderList() {
  const prs = searchFilter(bucketFilter(state.prs));
  if (state.loading) {
    list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    return;
  }
  if (!prs.length) {
    list.innerHTML = `<div class="empty"><span class="big">🐙</span>Nada por aquí. Mar en calma.</div>`;
    notifySelftestOnce();
    return;
  }
  list.innerHTML = prs
    .map(
      (pr) => `
      <article class="pr-row ${state.selected === pr.number ? "selected" : ""}" data-number="${pr.number}">
        <img class="avatar" src="${esc(pr.author?.avatarUrl || "")}" alt="" />
        <div class="pr-title-line">
          <span class="pr-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></span>
          ${labelPills(pr)}
        </div>
        <div class="pr-right">
          ${checksIcon(pr)}
          ${reviewChip(pr)}
          ${mergeStateChip(pr)}
          ${stateChip(pr)}
        </div>
        <div class="pr-sub">
          <span class="branches">
            <span class="branch" title="${esc(pr.headRefName)}">${esc(pr.headRefName)}</span>
            <span class="arrow">→</span>
            <span class="branch" title="${esc(pr.baseRefName)}">${esc(pr.baseRefName)}</span>
          </span>
          <span class="meta-mini">${esc(pr.author?.login || "?")} · ${timeAgo(pr.updatedAt)} · 💬 ${pr.comments?.totalCount ?? 0}</span>
        </div>
      </article>`,
    )
    .join("");

  list.querySelectorAll(".pr-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(Number(row.dataset.number)));
  });

  // En selftest abrimos el primer PR para capturar también el panel de detalle;
  // notifySelftestOnce se dispara al terminar de pintar ese detalle.
  if (IS_SELFTEST && !state.selftestOpenedDetail && prs.length) {
    state.selftestOpenedDetail = true;
    openDetail(prs[0].number);
  }
}

/* ============ render: detalle ============ */
function canMerge(pr) {
  return (
    pr.state === "OPEN" &&
    !pr.isDraft &&
    pr.mergeable === "MERGEABLE" &&
    ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus)
  );
}

function mergeBlockReason(pr) {
  if (pr.state !== "OPEN") return "La PR no está abierta";
  if (pr.isDraft) return "Es un borrador";
  if (pr.mergeable === "CONFLICTING") return "Tiene conflictos con la base";
  if (pr.mergeStateStatus === "BEHIND") return "La rama está atrasada: actualiza primero (rebase)";
  if (pr.mergeStateStatus === "BLOCKED") return "Bloqueada por checks o revisiones requeridas";
  return "";
}

function renderChecks(pr) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  if (!contexts.length) return `<p class="muted">Sin checks en el último commit.</p>`;
  return contexts
    .map((ctx) => {
      const name = ctx.name || ctx.context || "check";
      const status = (ctx.conclusion || ctx.status || ctx.state || "").toUpperCase();
      const ok = ["SUCCESS"].includes(status);
      const bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(status);
      const icon = ok ? `<span class="checks checks-success">✓</span>`
        : bad ? `<span class="checks checks-failure">✗</span>`
        : `<span class="checks checks-pending">●</span>`;
      const url = ctx.detailsUrl || ctx.targetUrl;
      const label = url ? `<a href="#" data-ext="${esc(url)}">${esc(name)}</a>` : esc(name);
      return `<div class="check-line">${icon} ${label} <span class="muted">${esc(status.toLowerCase())}</span></div>`;
    })
    .join("");
}

function renderReviews(pr) {
  const reviews = pr.latestReviews?.nodes || [];
  const requests = pr.reviewRequests?.nodes || [];
  if (!reviews.length && !requests.length) return `<p class="muted">Sin revisiones todavía.</p>`;
  const iconByState = {
    APPROVED: `<span class="checks checks-success">✓</span>`,
    CHANGES_REQUESTED: `<span class="checks checks-failure">±</span>`,
    COMMENTED: `<span class="checks checks-pending">💬</span>`,
  };
  const lines = reviews.map(
    (review) => `<div class="review-line">${iconByState[review.state] || "•"} ${esc(review.author?.login)} <span class="muted">${esc(review.state.toLowerCase().replace("_", " "))}</span></div>`,
  );
  const pending = requests
    .map((n) => n.requestedReviewer?.login || n.requestedReviewer?.name)
    .filter(Boolean)
    .map((who) => `<div class="review-line"><span class="checks checks-pending">⏳</span> ${esc(who)} <span class="muted">pendiente</span></div>`);
  return [...lines, ...pending].join("");
}

async function openDetail(number) {
  state.selected = number;
  renderList();
  detailPane.classList.remove("hidden");
  detailContent.innerHTML = `<div class="detail-inner"><div class="loading">Cargando #${number}…</div></div>`;
  let pr;
  try {
    pr = await window.pulpo.prDetail(state.repo, number);
  } catch (err) {
    detailContent.innerHTML = `<div class="detail-inner"><div class="error-box">${esc(String(err.message || err))}</div></div>`;
    notifySelftestOnce();
    return;
  }

  const blockReason = mergeBlockReason(pr);
  detailContent.innerHTML = `
    <div class="detail-inner">
      <button class="detail-close" id="detail-close" title="Cerrar">✕</button>
      <div class="detail-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></div>
      <div class="detail-sub">
        ${stateChip(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)}
        <span class="branches">
          <span class="branch">${esc(pr.headRefName)}</span><span class="arrow">→</span><span class="branch">${esc(pr.baseRefName)}</span>
        </span>
      </div>

      <div class="actions">
        <button class="btn btn-accent" id="act-update" ${pr.state !== "OPEN" ? "disabled" : ""}
                title="Actualiza la rama con la base usando rebase">⤴ Update branch (rebase)</button>
        <button class="btn btn-primary" id="act-merge" ${canMerge(pr) ? "" : "disabled"}
                title="${esc(blockReason || "Merge con merge commit")}">⇅ Merge (merge commit)</button>
        <button class="btn" id="act-open">Abrir en GitHub ↗</button>
      </div>
      ${blockReason && pr.state === "OPEN" ? `<p class="muted">⚠️ ${esc(blockReason)}</p>` : ""}

      <dl class="meta-grid">
        <dt>Autor</dt><dd>${esc(pr.author?.login)} · ${timeAgo(pr.createdAt)}</dd>
        <dt>Cambios</dt><dd><span class="checks-success">+${pr.additions}</span> / <span class="checks-failure">−${pr.deletions}</span> en ${pr.changedFiles} ficheros</dd>
        <dt>Mergeable</dt><dd>${esc(pr.mergeable?.toLowerCase() || "?")} · ${esc(pr.mergeStateStatus?.toLowerCase() || "?")}</dd>
        <dt>Comentarios</dt><dd>${pr.comments?.totalCount ?? 0}</dd>
      </dl>

      <div class="section-h">Checks</div>
      ${renderChecks(pr)}

      <div class="section-h">Revisiones</div>
      ${renderReviews(pr)}

      <div class="section-h">Descripción</div>
      <div class="pr-body">${pr.bodyHTML || "<p class='muted'>Sin descripción.</p>"}</div>
    </div>`;

  $("#detail-close").addEventListener("click", closeDetail);
  $("#act-open").addEventListener("click", () => window.pulpo.openExternal(pr.url));
  $("#act-update").addEventListener("click", () => updateBranch(pr));
  $("#act-merge").addEventListener("click", () => confirmMerge(pr));
  detailContent.querySelectorAll("[data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      window.pulpo.openExternal(a.dataset.ext);
    }),
  );
  // Los enlaces del bodyHTML salen al navegador.
  detailContent.querySelectorAll(".pr-body a").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      if (a.href?.startsWith("http")) window.pulpo.openExternal(a.href);
    }),
  );
  notifySelftestOnce();
}

function closeDetail() {
  state.selected = null;
  detailPane.classList.add("hidden");
  renderList();
}

/* ============ acciones ============ */
async function updateBranch(pr) {
  const btn = $("#act-update");
  btn.disabled = true;
  btn.textContent = "Rebasando…";
  try {
    await window.pulpo.updateBranch(pr.id);
    toast(`#${pr.number}: rama actualizada con rebase`, "ok");
    await refresh();
    openDetail(pr.number);
  } catch (err) {
    toast(`Update falló: ${String(err.message || err)}`, "err");
    btn.disabled = false;
    btn.textContent = "⤴ Update branch (rebase)";
  }
}

function confirmMerge(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>Merge de #${pr.number}</h3>
        <p><b>${esc(pr.headRefName)}</b> → <b>${esc(pr.baseRefName)}</b> con <b>merge commit</b>.</p>
        <p class="muted">Squash no es una opción. Nunca lo fue.</p>
        ${pr.isCrossRepository ? "" : `<label><input type="checkbox" id="del-branch" checked /> Borrar la rama tras el merge</label>`}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Confirmar merge</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const deleteBranch = $("#del-branch")?.checked ?? false;
    root.innerHTML = "";
    try {
      const res = await window.pulpo.mergePR({
        repo: state.repo,
        number: pr.number,
        deleteBranch,
        headRefName: pr.headRefName,
        isCrossRepository: pr.isCrossRepository,
      });
      toast(
        res.merged
          ? `#${pr.number} fusionada (merge commit)${res.branchDeleted ? " · rama borrada" : ""}`
          : `Merge no completado`,
        res.merged ? "ok" : "err",
      );
      closeDetail();
      await refresh();
    } catch (err) {
      toast(`Merge falló: ${String(err.message || err)}`, "err");
    }
  });
}

/* ============ carga de datos ============ */
function bucketStates() {
  if (state.bucket === "merged") return ["MERGED"];
  if (state.bucket === "closed") return ["CLOSED"];
  return ["OPEN"];
}

async function refresh() {
  if (!state.repo) return;
  state.loading = true;
  renderList();
  try {
    const prs = await window.pulpo.listPRs(state.repo, bucketStates());
    state.prs = prs;
    if (bucketStates()[0] === "OPEN") state.openPrs = prs;
    else if (!state.openPrs.length) {
      window.pulpo.listPRs(state.repo, ["OPEN"]).then((open) => {
        state.openPrs = open;
        renderCounts();
      }).catch(() => {});
    }
    state.loading = false;
    renderCounts();
    renderList();
  } catch (err) {
    state.loading = false;
    list.innerHTML = `<div class="error-box">No pude cargar ${esc(state.repo)}:<br>${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

function schedulePoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, (state.config?.pollSeconds || 60) * 1000);
}

/* ============ ajustes ============ */
function openSettings() {
  const root = $("#settings-root");
  root.classList.remove("hidden");
  const cfg = state.config;
  root.innerHTML = `
    <div class="settings-inner">
      <button class="btn" id="settings-back">← Volver</button>
      <h2 style="margin-top:14px">Ajustes</h2>

      <div class="settings-card">
        <h4>Repositorios</h4>
        <div id="repo-lines">
          ${cfg.repos.map((r) => `<div class="repo-line">${esc(r)} <button class="btn" data-del="${esc(r)}">Quitar</button></div>`).join("")}
        </div>
        <div class="add-repo">
          <input type="text" id="new-repo" placeholder="owner/repo" />
          <button class="btn btn-accent" id="add-repo">Añadir</button>
        </div>
      </div>

      <div class="settings-card">
        <h4>Token de GitHub</h4>
        <p class="muted">Origen actual: <b>${esc(state.authSource || "ninguno")}</b>. Se intenta <code>GITHUB_TOKEN</code> → <code>gh auth token</code> → token manual. Solo guarda uno manual si no usas gh CLI.</p>
        <div class="add-repo">
          <input type="password" id="manual-token" placeholder="${cfg.hasManualToken ? "•••••••• (guardado)" : "ghp_… (opcional)"}" />
          <button class="btn" id="save-token">Guardar</button>
        </div>
      </div>

      <div class="settings-card">
        <h4>Refresco automático</h4>
        <div class="add-repo">
          <input type="number" id="poll-seconds" min="15" value="${cfg.pollSeconds}" />
          <span class="muted" style="align-self:center">segundos</span>
        </div>
      </div>

      <div class="settings-card">
        <h4>Reglas de la casa</h4>
        <p class="muted">pull → <b>rebase</b> · merge → <b>merge commit</b> · squash → <b style="text-decoration:line-through">jamás</b>. No configurable. A propósito.</p>
      </div>
    </div>`;

  $("#settings-back").addEventListener("click", async () => {
    const pollSeconds = parseInt($("#poll-seconds").value, 10);
    if (Number.isInteger(pollSeconds) && pollSeconds >= 15 && pollSeconds !== cfg.pollSeconds) {
      state.config = await window.pulpo.setConfig({ pollSeconds });
      schedulePoll();
    }
    root.classList.add("hidden");
    root.innerHTML = "";
  });
  $("#add-repo").addEventListener("click", async () => {
    const value = $("#new-repo").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(value)) return toast("Formato esperado: owner/repo", "err");
    state.config = await window.pulpo.setConfig({ repos: [...cfg.repos, value] });
    renderRepoSelect();
    openSettings();
  });
  root.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      state.config = await window.pulpo.setConfig({ repos: cfg.repos.filter((r) => r !== btn.dataset.del) });
      if (state.repo === btn.dataset.del) state.repo = state.config.repos[0] || null;
      renderRepoSelect();
      openSettings();
    }),
  );
  $("#save-token").addEventListener("click", async () => {
    state.config = await window.pulpo.setConfig({ token: $("#manual-token").value });
    toast("Token guardado", "ok");
    boot();
  });
}

/* ============ arranque ============ */
function renderRepoSelect() {
  const select = $("#repo-select");
  select.innerHTML = (state.config?.repos || [])
    .map((r) => `<option value="${esc(r)}" ${r === state.repo ? "selected" : ""}>${esc(r)}</option>`)
    .join("");
}

async function boot() {
  state.config = await window.pulpo.getConfig();
  state.repo = state.repo && state.config.repos.includes(state.repo) ? state.repo : state.config.repos[0] || null;
  renderRepoSelect();

  const auth = await window.pulpo.authStatus();
  state.authSource = auth.source;
  if (auth.ok) {
    state.me = { login: auth.login, avatarUrl: auth.avatarUrl };
    $("#me").innerHTML = `<img src="${esc(auth.avatarUrl)}" alt="" /> ${esc(auth.login)}`;
  } else {
    $("#me").innerHTML = "";
    list.innerHTML = `<div class="error-box">Sin token de GitHub válido.<br>
      <span class="muted">Haz <code>gh auth login</code> en una terminal, exporta <code>GITHUB_TOKEN</code>, o guarda un token en Ajustes ⚙.</span></div>`;
    notifySelftestOnce();
    return;
  }
  await refresh();
  schedulePoll();
}

$("#refresh").addEventListener("click", refresh);
$("#settings-btn").addEventListener("click", openSettings);
$("#repo-select").addEventListener("change", (event) => {
  state.repo = event.target.value;
  state.openPrs = [];
  closeDetail();
  refresh();
});
$("#search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderList();
});
document.querySelectorAll(".bucket").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.bucket = btn.dataset.bucket;
    closeDetail();
    refresh();
  }),
);
document.addEventListener("keydown", (event) => {
  if (event.key === "r" && !event.metaKey && document.activeElement?.tagName !== "INPUT") refresh();
  if (event.key === "Escape") closeDetail();
});

boot();
