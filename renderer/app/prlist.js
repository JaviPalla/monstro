"use strict";

function stateChip(pr) {
  if (pr.state === "MERGED") return `<span class="chip chip-merged">${t("Fusionada")}</span>`;
  if (pr.state === "CLOSED") return `<span class="chip chip-closed">${t("Cerrada")}</span>`;
  if (pr.isDraft) return `<span class="chip chip-draft">${t("Borrador")}</span>`;
  return `<span class="chip chip-open">${t("Abierta")}</span>`;
}

function reviewChip(pr) {
  if (pr.state !== "OPEN") return "";
  switch (pr.reviewDecision) {
    case "APPROVED": return `<span class="chip chip-approved">${icon("check")} ${t("Aprobada")}</span>`;
    case "CHANGES_REQUESTED": return `<span class="chip chip-changes">${icon("file-diff")} ${t("Cambios pedidos")}</span>`;
    case "REVIEW_REQUIRED": return `<span class="chip chip-review">${t("Falta revisión")}</span>`;
    default: return "";
  }
}

function mergeStateChip(pr) {
  if (pr.state !== "OPEN") return "";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    return `<span class="chip chip-conflict">${t("Conflictos")}</span>`;
  if (pr.mergeStateStatus === "BEHIND") return `<span class="chip chip-behind">${t("Rama atrasada")}</span>`;
  return "";
}

function checksIcon(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return "";
  const map = {
    SUCCESS: ["circle-check", "checks-success", t("Checks en verde")],
    FAILURE: ["circle-x", "checks-failure", t("Checks fallando")],
    ERROR: ["circle-x", "checks-failure", t("Checks con error")],
    PENDING: ["circle-dot", "checks-pending", t("Checks en curso")],
    EXPECTED: ["circle-dot", "checks-pending", t("Checks esperados")],
  };
  const [name, cls, title] = map[rollup.state] || ["", "", ""];
  return name ? `<span class="checks ${cls}" title="${title}">${icon(name)}</span>` : "";
}

/** Avatares con tick verde de quienes han aprobado (estilo Bitbucket). */
function approvalFaces(pr) {
  const approvers = [];
  const seen = new Set();
  for (const review of pr.latestReviews?.nodes || []) {
    if (review.state !== "APPROVED" || !review.author || seen.has(review.author.login)) continue;
    seen.add(review.author.login);
    approvers.push(review.author);
  }
  if (!approvers.length) return "";
  const MAX_FACES = 4;
  const shown = approvers.slice(0, MAX_FACES);
  const extra = approvers.length - shown.length;
  return `
    <span class="facepile" title="${t("Aprobada por {who}", { who: esc(approvers.map((a) => a.login).join(", ")) })}">
      ${shown.map((a) => `
        <span class="face">
          <img src="${esc(a.avatarUrl)}" alt="${esc(a.login)}" />
          <span class="face-tick">${icon("check")}</span>
        </span>`).join("")}
      ${extra > 0 ? `<span class="face face-more">+${extra}</span>` : ""}
    </span>`;
}

/* ---------- repo, sesión y conflictos de una fila ---------- */

// Nombre del proyecto SIN el grupo, con su icono: la inicial sobre un color derivado del nombre, igual que
// hace GitLab cuando el proyecto no tiene avatar.
// ponytail: avatar real no — los uploads de un proyecto privado piden cookie de sesión, no el token, así que
// la <img> daría 401; haría falta proxiarlos por main a dataURL.
function repoPill(pr) {
  const full = pr.repository?.nameWithOwner || state.repo || "";
  const name = full.split("/").pop();
  if (!name) return "";
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="label-pill repo-pill" title="${esc(full)}"><span class="repo-ico" style="background:hsl(${hash} 55% 45%)">${esc(name[0].toUpperCase())}</span>${esc(name)}</span>`;
}

const prKey = (pr) => `${pr.repository?.nameWithOwner || state.repo}#${pr.number}`;
const hasDrafts = (pr) => state.draftKeys.has(prKey(pr));

// Sesión de agente enlazada con esta MR (el panel de Agents las cruza por proyecto + iid).
function sessionFor(pr) {
  const repo = pr.repository?.nameWithOwner || state.repo;
  return (sessionsUi.data || []).find((s) =>
    s.links.some((l) => (l.kind === "mr" || l.kind === "pr") && l.project === repo && l.iid === pr.number),
  );
}

function sessionBadge(pr) {
  const s = sessionFor(pr);
  if (!s) return "";
  // Solo el icono: el título de la sesión va en el tooltip para no comerle ancho al de la MR.
  const label = s.review ? t("Review de un agente") : t("Agente");
  return `<button class="pr-agent" data-session="${esc(s.sessionId)}" title="${esc(`${label}: ${s.title}`)}">${icon("bot")}</button>`;
}

const hasConflicts = (pr) => pr.state === "OPEN" && (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY");

function conflictButton(pr) {
  if (!hasConflicts(pr)) return "";
  return `<button class="pr-fix" data-fix="${esc(pr.url)}">${icon("wrench")} ${t("Solucionar conflictos")}</button>`;
}

async function launchConflictFix(url, btn) {
  btn.disabled = true;
  try {
    await window.monstro.sessionsLaunch(url, "conflicts");
    toast(t("Agente abierto en Ghostty sobre un worktree de la rama"), "ok");
    setTimeout(loadSessions, 4000);
  } catch (err) {
    toast(ipcMessage(err), "err");
  } finally {
    btn.disabled = false;
  }
}

function labelPills(pr) {
  return (pr.labels?.nodes || [])
    .map((l) => `<span class="label-pill" style="background:#${l.color}22;color:#${l.color}">${esc(l.name)}</span>`)
    .join("");
}

/* ============ lista de PRs ============ */
function searchFilter(prs) {
  const q = state.search.trim().toLowerCase();
  if (!q) return prs;
  return prs.filter((p) =>
    [p.title, p.headRefName, p.baseRefName, p.author?.login, String(p.number)].join(" ").toLowerCase().includes(q),
  );
}

function renderCounts() {
  $("#count-open").textContent = state.openPrs.length || "";
}

function renderList() {
  if (state.view !== "prs") return;
  // Las que tienen comentarios en borrador sin publicar, primero.
  const prs = searchFilter(state.prs).slice().sort((a, b) => hasDrafts(b) - hasDrafts(a));
  if (state.loading) {
    list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    return;
  }
  if (!prs.length) {
    list.innerHTML = `<div class="empty"><span class="big">${mascot(48)}</span>${t("Nada por aquí. Todo tranquilo.")}</div>`;
    notifySelftestOnce();
    return;
  }
  list.innerHTML = prs
    .map(
      (pr) => `
      <article class="pr-row ${state.selected === pr.number ? "selected" : ""}" data-number="${pr.number}" data-repo="${esc(pr.repository?.nameWithOwner || state.repo)}">
        <img class="avatar" src="${esc(pr.author?.avatarUrl || "")}" alt="" />
        <div class="pr-title-line">
          ${state.repo === ALL_REPOS ? repoPill(pr) : ""}
          <span class="pr-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></span>
          ${labelPills(pr)}
          ${sessionBadge(pr)}
        </div>
        <div class="pr-right">
          ${approvalFaces(pr)} ${checksIcon(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)} ${stateChip(pr)}
        </div>
        <div class="pr-sub">
          <span class="branches">
            <span class="branch" title="${esc(pr.headRefName)}">${esc(pr.headRefName)}</span>
            <span class="arrow">${icon("arrow-right")}</span>
            <span class="branch" title="${esc(pr.baseRefName)}">${esc(pr.baseRefName)}</span>
          </span>
          <span class="meta-mini">${esc(pr.author?.login || "?")} · ${timeAgo(pr.updatedAt)} · <span class="checks-success">+${pr.additions ?? 0}</span>/<span class="checks-failure">−${pr.deletions ?? 0}</span> · ${icon("message-square")} ${pr.comments?.totalCount ?? 0}${hasDrafts(pr) ? ` · ${icon("file-pen-line")} ${t("borradores")}` : ""}</span>
          ${conflictButton(pr)}
        </div>
      </article>`,
    )
    .join("");
  list.querySelectorAll(".pr-row").forEach((row) =>
    row.addEventListener("click", (ev) => {
      const agent = ev.target.closest("[data-session]");
      if (agent) {
        if (!sessionsOpen()) toggleSessionsPane(true);
        if (viewingId() !== agent.dataset.session) openSessionView(agent.dataset.session);
        return;
      }
      const fix = ev.target.closest("[data-fix]");
      if (fix) return launchConflictFix(fix.dataset.fix, fix);
      openDetail(Number(row.dataset.number), "conv", row.dataset.repo);
    }),
  );

  if (IS_SELFTEST && !state.selftestOpenedDetail && prs.length && (["list", "changes"].includes(SELFTEST_ROUTE) || SELFTEST_ROUTE.startsWith("review"))) {
    state.selftestOpenedDetail = true;
    // El repo va explícito: con "All repos" state.repo es "__all__" y el detalle daría 404.
    openDetail(prs[0].number, SELFTEST_ROUTE === "list" ? "conv" : "changes", prs[0].repository?.nameWithOwner);
  }
}

/* ============ detalle de PR: shell + tabs ============ */
function canMerge(pr) {
  return (
    pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" &&
    ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus)
  );
}

function mergeBlockReason(pr) {
  if (pr.state !== "OPEN") return t("La PR no está abierta");
  if (pr.isDraft) return t("Es un borrador");
  if (pr.mergeable === "CONFLICTING") return t("Tiene conflictos con la base");
  if (pr.mergeStateStatus === "BEHIND") return t("La rama está atrasada: actualiza primero (rebase)");
  if (pr.mergeStateStatus === "BLOCKED") return t("Bloqueada por checks o revisiones requeridas");
  return "";
}
