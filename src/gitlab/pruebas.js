"use strict";

// Sección Pruebas (solo GitLab): las tareas que alguien tiene que probar —epics, issues locales, MRs sueltas
// y hotfix— con el pipeline del flujo de delivery-flow. Las reglas puras están en src/pruebas-rules.js.
// Coste: 3 llamadas de issues + ⌈MRs/100⌉ de MRs a nivel de grupo, 1 por epic (related_merge_requests) y,
// por tarjeta, el pipeline de la epic y el detalle + jobs de cada MR. Sin auto-refresco.

const { api, apiAll, mapLimit, resolveToken, settings } = require("./core");
const { isEpicUrl, milestonesGroup } = require("./issues");
const rules = require("../pruebas-rules");

const enc = encodeURIComponent;
const FLOW_NAMES = new Set([...Object.values(rules.EPIC_JOBS), ...Object.values(rules.MR_JOBS)]);

// references.full = "Grupo/proyecto#12" o "Grupo/proyecto!12": para mostrar, el último tramo del path.
const repoName = (full) => String(full || "").split(/[#!]/)[0].split("/").pop();

// Issues abiertas con etiqueta de ciclo: las epics (proyecto epics) y las locales de los proyectos del flujo.
async function cycleIssues(group) {
  const lists = await Promise.all(
    rules.CYCLE_LABELS.map((l) => apiAll(`/groups/${enc(group)}/issues?labels=${enc(l)}&state=opened&scope=all`)),
  );
  const seen = new Set();
  return lists
    .flat()
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
    .map((i) => ({
      iid: i.iid,
      projectId: i.project_id,
      repo: repoName(i.references?.full),
      title: i.title,
      url: i.web_url,
      labels: i.labels || [],
      isEpic: isEpicUrl(i.web_url),
    }))
    .filter((i) => (i.isEpic ? i.projectId === rules.EPICS_PROJECT : rules.FLOW_PROJECTS.includes(i.projectId)));
}

// MRs abiertas hacia development de los proyectos del flujo (una consulta de grupo, paginada).
async function openMRs(group) {
  const all = await apiAll(`/groups/${enc(group)}/merge_requests?state=opened&target_branch=development&scope=all`);
  return all
    .filter((m) => rules.FLOW_PROJECTS.includes(m.project_id))
    .map((m) => ({
      projectId: m.project_id,
      iid: m.iid,
      repo: repoName(m.references?.full),
      title: m.title,
      description: m.description || "",
      branch: m.source_branch,
      labels: m.labels || [],
      draft: !!m.draft,
      url: m.web_url,
    }));
}

// Todas las etiquetas del grupo (los proyectos las heredan): el filtro las ofrece aunque ninguna tarea las lleve.
async function groupLabels(group) {
  return (await apiAll(`/groups/${enc(group)}/labels`)).map((l) => l.name);
}

async function relatedOf(epicIid) {
  const list = await api("GET", `/projects/${rules.EPICS_PROJECT}/issues/${epicIid}/related_merge_requests?per_page=100`);
  return list.map((m) => ({ projectId: m.project_id, iid: m.iid }));
}

// La traza es texto plano (api() la intentaría parsear como JSON). Solo se pide para jobs fallidos del flujo.
async function jobTrace(projectId, jobId) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(`${settings().apiBase}/projects/${projectId}/jobs/${jobId}/trace`, {
    headers: { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(-200000);
}

async function pipelineJobs(projectId, pipelineId) {
  const jobs = await apiAll(`/projects/${projectId}/pipelines/${pipelineId}/jobs`);
  const out = jobs.map((j) => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, url: j.web_url || null, projectId, reason: null }));
  // Por qué se negó o falló: stderr de la traza. Si no se puede leer, el job se queda sin motivo.
  await mapLimit(
    out.filter((j) => j.status === "failed" && FLOW_NAMES.has(j.name)),
    4,
    async (j) => {
      try {
        j.reason = rules.traceReason(await jobTrace(projectId, j.id));
      } catch {
        j.reason = null;
      }
    },
  );
  return out;
}

// El pipeline más reciente `Epic #N` (la ronda vigente; el bot cancela las anteriores).
async function epicPipeline(epicIid) {
  const [p] = await api("GET", `/projects/${rules.EPICS_PROJECT}/pipelines?name=${enc(`Epic #${epicIid}`)}&per_page=1`);
  if (!p) return null;
  return { id: p.id, status: p.status, url: p.web_url, jobs: await pipelineJobs(rules.EPICS_PROJECT, p.id) };
}

// La lista de MRs no trae head_pipeline: hay que pedir la MR.
async function mrDetail({ projectId, iid }) {
  const mr = await api("GET", `/projects/${projectId}/merge_requests/${iid}`);
  const hp = mr.head_pipeline;
  return {
    projectId,
    iid,
    draft: !!mr.draft,
    mergeStatus: mr.detailed_merge_status || null,
    pipeline: hp ? { id: hp.id, status: hp.status, url: hp.web_url } : null,
    jobs: hp ? await pipelineJobs(projectId, hp.id) : [],
  };
}

/** Pipelines y estado de una tarea: `epicIid` (o null) y sus MRs [{projectId, iid}]. */
async function pruebasTask({ epicIid, mrs }) {
  const [epic, details] = await Promise.all([
    epicIid ? epicPipeline(epicIid) : null,
    mapLimit(mrs, 4, (m) =>
      mrDetail(m).catch((err) => ({ projectId: m.projectId, iid: m.iid, error: String(err.message || err), pipeline: null, jobs: [] })),
    ),
  ]);
  return rules.summarize({ epicIid, epic, mrs: details });
}

/**
 * { tasks, errors, labels, loaded, total }. La lista de tareas sale en ~1 s y se empuja enseguida con
 * `onProgress`; luego cada tarjeta carga sus pipelines y se vuelve a empujar (como mucho cada ~0,5 s).
 */
async function pruebasBoard(onProgress = () => {}) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado (revisa repos o config.milestones.group).");
  const errors = [];
  const [issues, mrs, labels] = await Promise.all([
    cycleIssues(group),
    openMRs(group),
    groupLabels(group).catch((err) => {
      errors.push({ task: "Etiquetas", error: String(err.message || err) });
      return [];
    }),
  ]);
  const related = {};
  await mapLimit(issues.filter((i) => i.isEpic), 4, async (e) => {
    try {
      related[e.iid] = await relatedOf(e.iid);
    } catch (err) {
      related[e.iid] = [];
      errors.push({ task: `#${e.iid}`, error: String(err.message || err) });
    }
  });
  const tasks = rules.buildTasks({ issues, mrs, related });
  let loaded = 0;
  let last = 0;
  const snapshot = () => ({ tasks, errors, labels, loaded, total: tasks.length });
  onProgress(snapshot());
  await mapLimit(tasks, 4, async (task) => {
    try {
      task.detail = await pruebasTask({ epicIid: task.epicIid, mrs: task.mrs });
    } catch (err) {
      task.error = String(err.message || err);
    }
    loaded++;
    if (Date.now() - last >= 500) {
      last = Date.now();
      onProgress(snapshot());
    }
  });
  return snapshot();
}

/** ▶ (play, con MOTIVO opcional) o ↻ (retry) de un job. Los permisos los decide GitLab con el token del usuario. */
async function pruebasAct(project, jobId, kind, motivo) {
  const body = kind === "play" && motivo ? { job_variables_attributes: [{ key: "MOTIVO", value: motivo }] } : undefined;
  const j = await api("POST", `/projects/${project}/jobs/${jobId}/${kind}`, body);
  return { ok: true, jobId: j.id, status: j.status, url: j.web_url || null };
}

/**
 * Crea el pipeline `Epic #N` en el proyecto epics (como el bot). Al ser origen `api`, `probar-tarea` queda
 * en manual: lo pulsa una persona. Si ya hay una ronda sin terminar no crea otra.
 */
async function pruebasNewPipeline(epicIid) {
  const epic = await api("GET", `/projects/${rules.EPICS_PROJECT}/issues/${epicIid}`);
  if (epic.state !== "opened") throw new Error(`La epic #${epicIid} no está abierta`);
  const [last] = await api("GET", `/projects/${rules.EPICS_PROJECT}/pipelines?name=${enc(`Epic #${epicIid}`)}&per_page=1`);
  if (last && rules.isOpenPipeline(last.status)) return { created: false, id: last.id, url: last.web_url, status: last.status };
  const p = await api("POST", `/projects/${rules.EPICS_PROJECT}/pipeline`, { ref: "master", variables: [{ key: "EPIC_IID", value: String(epicIid) }] });
  return { created: true, id: p.id, url: p.web_url, status: p.status };
}

/** «Run pipeline» de la pestaña Pipelines de una MR (tareas sin epic y hotfix): crea un pipeline de merge request. */
async function pruebasRunMrPipeline(projectId, iid) {
  const p = await api("POST", `/projects/${projectId}/merge_requests/${iid}/pipelines`);
  return { id: p.id, url: p.web_url, status: p.status };
}

module.exports = { pruebasAct, pruebasBoard, pruebasNewPipeline, pruebasRunMrPipeline, pruebasTask };
