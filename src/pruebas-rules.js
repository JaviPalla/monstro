"use strict";

// Reglas PURAS (sin red) de la sección Pruebas: qué tareas hay, qué botón corresponde a cada job y qué
// estado cuenta la cabecera. Replican a propósito partes de OpenSaludGroup/delivery-flow
// (scripts/task-model.cjs, epic/.gitlab-ci.yml, templates/): si el flujo cambia un nombre de job o los
// proyectos habilitados, hay que cambiarlo aquí. `node scripts/test-pruebas.js`

const EPICS_PROJECT = 62;
// ENABLED_PROJECTS de delivery-flow/scripts/epic-tasks.cjs: launcher, API, landing, dashboard,
// usermanagement, notifications y companies.
const FLOW_PROJECTS = [11, 12, 13, 19, 25, 42, 67];
const CYCLE_LABELS = ["pending check", "checking", "needs fixing"];

const EPIC_JOBS = { probar: "probar-tarea", validar: "validar-tarea", devolver: "devolver-tarea", mergear: "mergear-tarea" };
const MR_JOBS = { probar: "probar-tarea-en-desarrollo", deploy: "desplegar-en-dev", deployMx: "desplegar-en-dev-mx", validar: "validar-tarea-para-mergear" };
const FLOW_JOB_NAMES = new Set([...Object.values(EPIC_JOBS), ...Object.values(MR_JOBS)]);
const EPIC_ORDER = [EPIC_JOBS.probar, EPIC_JOBS.validar, EPIC_JOBS.devolver, EPIC_JOBS.mergear];
const ACTIVE = new Set(["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"]);
// Jobs que avanzan solos. `created` no: los de las fases posteriores esperan siempre en `created`.
const LIVE = new Set([...ACTIVE].filter((s) => s !== "created"));
// Una ronda de pipeline sin terminar: en marcha, en cola (resource_group) o esperando un ▶.
const isOpenPipeline = (status) => status === "manual" || ACTIVE.has(status);

/* ---------- qué tareas hay ---------- */

const EPIC_SHORT = /(?:^|[^\w.-])(?:[A-Za-z0-9_.-]+\/)*epics#(\d+)/g;
const EPIC_URL = /\/OpenSaludGroup\/epics\/-\/issues\/(\d+)/g;
const ISSUE_REF = /\b(?:Refs|Closes|Fixes|Resolves|Related to)\s+#(\d+)/i;
const BRANCH_ISSUE = /^(?:features?|feat|bugfix|hotfix|fix)\/(\d+)(?:-|$)/i;

// Epics que cita un texto (`epics#N` o la URL de la issue), como task-model.cjs de delivery-flow.
function epicRefs(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(EPIC_SHORT)) found.add(Number(m[1]));
  for (const m of String(text || "").matchAll(EPIC_URL)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

// Issue local (del proyecto de la MR) en la que trabaja: la descripción manda, el número de la rama es
// solo una pista (features/343-x puede ser otra cosa).
function mrIssueNumber(mr) {
  const ref = ISSUE_REF.exec(mr.description || "");
  if (ref) return Number(ref[1]);
  const branch = BRANCH_ISSUE.exec(mr.branch || "");
  return branch ? Number(branch[1]) : null;
}

const isHotfix = (mr) => /^hotfix\//.test(mr.branch || "") || (mr.labels || []).includes("sin-dev");
const cycleLabel = (labels) => CYCLE_LABELS.find((l) => (labels || []).includes(l)) || null;
const mrKey = (m) => `${m.projectId}!${m.iid}`;
const mrView = (m) => ({ projectId: m.projectId, iid: m.iid, repo: m.repo, title: m.title, url: m.url, branch: m.branch, draft: m.draft, labels: m.labels });

/**
 * Tarjetas de la sección. `issues` = issues abiertas con etiqueta de ciclo (epics del proyecto `epics` y
 * locales de los proyectos del flujo); `mrs` = MRs abiertas a development de esos proyectos; `related` =
 * `related_merge_requests` de cada epic ({ [iid]: [{projectId, iid}] }). Una MR que ya está en la tarjeta
 * de una epic o de una issue no vuelve a salir como hotfix o MR suelta.
 */
function buildTasks({ issues, mrs, related }) {
  const byKey = new Map(mrs.map((m) => [mrKey(m), m]));
  const claimed = new Set();
  const claim = (list) => {
    list.forEach((m) => claimed.add(mrKey(m)));
    return list.map(mrView);
  };
  const tasks = [];
  const task = (kind, issue, epicIid, list) => ({
    key: `${kind}:${issue.projectId}#${issue.iid}`,
    kind,
    ref: kind === "epic" ? `#${issue.iid}` : `${issue.repo}#${issue.iid}`,
    title: issue.title,
    url: issue.url,
    label: cycleLabel(issue.labels),
    labels: issue.labels || [],
    hotfix: false,
    epicIid,
    mrs: claim(list),
    detail: null,
  });

  const epics = issues.filter((i) => i.isEpic).sort((a, b) => b.iid - a.iid);
  for (const e of epics) {
    // related_merge_requests incluye menciones incidentales: solo cuentan las que citan esta epic.
    const cited = (related[e.iid] || [])
      .map((r) => byKey.get(`${r.projectId}!${r.iid}`))
      .filter((m) => m && epicRefs(`${m.title}\n${m.description}`).includes(e.iid));
    tasks.push(task("epic", e, e.iid, cited));
  }
  for (const i of issues.filter((x) => !x.isEpic)) {
    const all = mrs.filter((m) => m.projectId === i.projectId && mrIssueNumber(m) === i.iid);
    const own = all.filter((m) => !claimed.has(mrKey(m)));
    if (all.length && !own.length) continue; // todas sus MRs ya están en la tarjeta de su epic
    tasks.push(task("issue", i, null, own));
  }
  for (const m of mrs) {
    if (claimed.has(mrKey(m))) continue;
    const hot = isHotfix(m);
    if (!hot && !cycleLabel(m.labels)) continue;
    tasks.push({
      key: `mr:${mrKey(m)}`,
      kind: "mr",
      ref: `${m.repo}!${m.iid}`,
      title: m.title,
      url: m.url,
      label: cycleLabel(m.labels),
      labels: m.labels || [],
      hotfix: hot,
      epicIid: null,
      mrs: claim([m]),
      detail: null,
    });
  }
  return tasks;
}

/* ---------- traza de un job fallido ---------- */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// El runner antepone `<fecha> <nn><O|E>[+] ` a cada línea; E = stderr, que es donde delivery-flow dice por qué se niega.
const TRACE_LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+\d\d([OE])\+?\s?(.*)$/;

function traceReason(text, max = 15) {
  const out = [];
  for (const line of String(text || "").replace(ANSI, "").split(/\r?\n/)) {
    const m = TRACE_LINE.exec(line);
    if (m && m[1] === "E" && m[2].trim()) out.push(m[2].trimEnd());
  }
  return out.slice(-max);
}

/* ---------- jobs: botón, confirmación y orden ---------- */

// `ctx`: { probarStatus } del job probar-tarea-en-desarrollo de la MR; { pipelineStatus } del pipeline del job.
function decorateJob(job, ctx = {}) {
  let action = null;
  if (ctx.pipelineStatus !== "canceled") {
    if (job.status === "manual") action = "play";
    else if (job.status === "failed" || job.status === "canceled") action = "retry";
  }
  let confirm = null;
  if (job.name === EPIC_JOBS.mergear) confirm = "merge";
  else if (job.name === EPIC_JOBS.devolver) confirm = "return";
  else if (job.name === MR_JOBS.validar && ctx.probarStatus !== "success") confirm = "no-dev"; // validación sin pasar por dev
  return { ...job, flow: FLOW_JOB_NAMES.has(job.name), action, confirm: action ? confirm : null };
}

function orderJobs(jobs, names) {
  const rank = (j) => {
    const i = names.indexOf(j.name);
    return i === -1 ? names.length : i;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b));
}

/* ---------- estado de la cabecera ---------- */

const STATE_RANK = { "no-pipeline": 0, unknown: 0, "probar-ready": 1, "probar-failed": 1, deploying: 2, "deploy-failed": 2, "in-dev": 3, "validate-failed": 3, "merge-ready": 4 };

function mrState(jobs) {
  if (!jobs.length) return "no-pipeline";
  const by = (n) => jobs.find((j) => j.name === n);
  const probar = by(MR_JOBS.probar);
  const deploy = by(MR_JOBS.deploy);
  const validar = by(MR_JOBS.validar);
  if (validar?.status === "success") return "merge-ready";
  if (validar?.status === "failed") return "validate-failed";
  if (deploy?.status === "failed") return "deploy-failed";
  if (deploy?.status === "success") return "in-dev";
  if (probar?.status === "failed") return "probar-failed";
  if (probar?.status === "success" && deploy && ACTIVE.has(deploy.status)) return "deploying";
  if (probar?.status === "manual") return "probar-ready";
  return "unknown";
}

// La tarea sin epic va con su MR más atrasada.
function worstState(states) {
  if (!states.length) return "no-mrs";
  return states.reduce((w, s) => ((STATE_RANK[s] ?? 0) < (STATE_RANK[w] ?? 0) ? s : w));
}

// `pipelineStatus` null = la epic no tiene pipeline. `mrStates` = estado de cada MR de la epic.
function epicState(jobs, pipelineStatus, mrStates = []) {
  if (!pipelineStatus) return "no-pipeline";
  if (pipelineStatus === "canceled") return "canceled";
  const by = (n) => jobs.find((j) => j.name === n);
  const probar = by(EPIC_JOBS.probar);
  const validar = by(EPIC_JOBS.validar);
  const mergear = by(EPIC_JOBS.mergear);
  if (mergear?.status === "success") return "merged";
  // validar-tarea es allow_failure: si falla, mergear-tarea puede quedar en manual. Se cuenta lo que pasó, no lo que se puede pulsar.
  if (validar?.status === "failed") return "validar-failed";
  if (mergear && ACTIVE.has(mergear.status) && mergear.status !== "created") return "mergeando";
  if (mergear?.status === "failed") return "mergear-failed";
  if (mergear?.status === "manual") return "mergear-ready";
  if (validar && ACTIVE.has(validar.status) && validar.status !== "created") return "validando";
  if (probar?.status === "failed") return "probar-failed";
  if (probar?.status === "manual") return "probar-ready";
  if (probar?.status === "canceled") return "canceled";
  if (probar?.status === "success") {
    if (mrStates.includes("deploy-failed")) return "deploy-failed";
    // validar-tarea ya está en manual aunque las MRs sigan desplegando: no es «lista» hasta que todas estén en dev.
    if (mrStates.some((s) => s !== "in-dev" && s !== "merge-ready")) return "probando";
    return validar?.status === "manual" ? "validar-ready" : "probando";
  }
  if (probar && ACTIVE.has(probar.status)) return "probando";
  return "unknown";
}

/**
 * Lo que recibe el renderer para una tarea: jobs ordenados y con su botón, estado por MR y de la tarea.
 * `epic` = { id, status, url, jobs } (o null si la epic no tiene pipeline); `mrs` = [{ projectId, iid, …, pipeline, jobs }].
 */
function summarize({ epicIid, epic, mrs }) {
  const mrOut = mrs.map((m) => {
    const jobs = m.jobs || [];
    const ctx = { probarStatus: jobs.find((j) => j.name === MR_JOBS.probar)?.status, pipelineStatus: m.pipeline?.status };
    return { ...m, jobs: orderJobs(jobs, Object.values(MR_JOBS)).map((j) => decorateJob(j, ctx)), state: mrState(jobs) };
  });
  const epicJobs = epic ? epic.jobs : [];
  // `live`: algún job en marcha o en cola; el renderer recarga esa tarjeta sola mientras siga así.
  const live = [...epicJobs, ...mrOut.flatMap((m) => m.jobs)].some((j) => LIVE.has(j.status));
  if (!epicIid) return { epic: null, mrs: mrOut, state: worstState(mrOut.map((m) => m.state)), live };
  const pipelineStatus = epic ? epic.status : null;
  const state = epicState(epicJobs, pipelineStatus, mrOut.map((m) => m.state));
  return {
    epic: {
      pipeline: epic ? { id: epic.id, status: epic.status, url: epic.url } : null,
      jobs: orderJobs(epicJobs, EPIC_ORDER).map((j) => decorateJob(j, { pipelineStatus })),
      state,
    },
    mrs: mrOut,
    state,
    live,
  };
}

/* ---------- lo que llega del renderer (no se da por bueno) ---------- */

const isPosInt = (v) => Number.isInteger(v) && v > 0;

function parseAct({ project, jobId, kind, motivo } = {}) {
  const p = Number(project);
  if (![EPICS_PROJECT, ...FLOW_PROJECTS].includes(p)) throw new Error("Proyecto no válido");
  const job = Number(jobId);
  if (!/^\d+$/.test(String(jobId)) || !isPosInt(job)) throw new Error("Job no válido");
  if (!["play", "retry"].includes(kind)) throw new Error("Acción no válida");
  const text = typeof motivo === "string" ? motivo.trim().slice(0, 500) : "";
  return { project: p, jobId: job, kind, motivo: kind === "play" ? text : "" };
}

function parseEpicIid(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error("Número de epic no válido");
  return Number(value);
}

function parseMrRef(m) {
  const projectId = Number(m?.projectId);
  const iid = Number(m?.iid);
  if (!FLOW_PROJECTS.includes(projectId) || !isPosInt(iid)) throw new Error("MR no válida");
  return { projectId, iid };
}

function parseTaskRef({ epicIid, mrs } = {}) {
  const epic = epicIid == null ? null : parseEpicIid(epicIid);
  if (!Array.isArray(mrs) || mrs.length > 30) throw new Error("MRs no válidas");
  return { epicIid: epic, mrs: mrs.map(parseMrRef) };
}

module.exports = {
  CYCLE_LABELS,
  EPICS_PROJECT,
  EPIC_JOBS,
  FLOW_PROJECTS,
  MR_JOBS,
  buildTasks,
  cycleLabel,
  decorateJob,
  epicRefs,
  epicState,
  isHotfix,
  isOpenPipeline,
  mrIssueNumber,
  mrState,
  orderJobs,
  parseAct,
  parseEpicIid,
  parseMrRef,
  parseTaskRef,
  summarize,
  traceReason,
  worstState,
};
