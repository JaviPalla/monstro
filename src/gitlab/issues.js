"use strict";

// milestones, issues, epics, work items, etiquetas y proyectos del grupo, y el resumen espejado en el milestone.
// Parte de la implementación del proveedor GitLab — ver src/gitlab.js para la interfaz pública.

const config = require("../config");
const { api, apiAll, chunk, fetchAvatarDataUri, graphql, mapLimit, mdToSafeHtml, proj, viewer } = require("./core");

function milestonesGroup() {
  const cfg = config.load();
  const explicit = cfg.milestones?.group;
  if (explicit) return explicit;
  const first = (cfg.repos || [])[0] || "";
  return first.split("/")[0] || null;
}

function mapMilestone(m) {
  return {
    id: m.id,
    iid: m.iid,
    title: m.title,
    description: m.description || "",
    dueDate: m.due_date || null,
    startDate: m.start_date || null,
    state: m.state, // "active" | "closed"
    webUrl: m.web_url,
  };
}

function mapAssignee(u) {
  // id numérico necesario para assignee_ids al reasignar; el resto es para pintar.
  return { id: u.id, username: u.username, name: u.name || u.username, avatarUrl: u.avatar_url || null };
}

// Con with_labels_details=true, `labels` llega como objetos {name,color,text_color}.

function mapIssue(issue) {
  const labels = (issue.labels || []).map((l) =>
    typeof l === "string" ? { name: l, color: null, textColor: null } : { name: l.name, color: l.color, textColor: l.text_color },
  );
  const description = issue.description || "";
  return {
    id: issue.id, // id global (= WorkItem id en GraphQL), para resolver la jerarquía padre
    iid: issue.iid,
    projectId: issue.project_id,
    issueType: issue.issue_type, // "issue" | "task" (work item) | ...
    // references.full = "group/project#iid"; nos quedamos con el path del proyecto.
    projectPath: (issue.references?.full || "").replace(/#\d+$/, ""),
    title: issue.title,
    descriptionHtml: mdToSafeHtml(description), // markdown crudo -> HTML seguro (no inyectar sin escapar)
    hasDescription: Boolean(description.trim()),
    state: issue.state, // "opened" | "closed"
    webUrl: issue.web_url,
    labels,
    assignees: (issue.assignees || []).map(mapAssignee),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

async function listMilestones() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const ms = await apiAll(`/groups/${encodeURIComponent(group)}/milestones?state=active&include_ancestors=true`);
  return ms.map(mapMilestone);
}

// OJO: el parámetro de la API de issues es `milestone` (título), NO `milestone_title`
// (ese es para el endpoint de milestones); si te equivocas, GitLab lo ignora en silencio
// y te devuelve TODOS los issues del grupo. Por defecto solo abiertas: las cerradas
// (que pueden ser miles en un grupo activo) no deben comerse el límite de paginación.

async function milestoneIssues(milestoneTitle, { includeClosed = false } = {}) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const enc = encodeURIComponent(group);
  const mt = encodeURIComponent(milestoneTitle);
  const state = includeClosed ? "all" : "opened";
  const issues = await apiAll(`/groups/${enc}/issues?milestone=${mt}&state=${state}&with_labels_details=true`);
  const mapped = issues.map(mapIssue);
  for (const iss of mapped) iss.isEpic = isEpicUrl(iss.webUrl);
  // Botones de MR (solo de cierre, batch rápido) para las issues normales ABIERTAS. Las cerradas
  // se saltan en la carga (rendimiento) y se piden bajo demanda al activar "Mostrar cerradas"
  // (issueMRs); marcadas con mrsPending. Las Epics no tienen MR propia: sus MRs son las de sus
  // hijas, que se cargan al desplegar el caret (milestoneEpicChildren).
  const openNonEpics = mapped.filter((iss) => !iss.isEpic && iss.state !== "closed");
  let mrs = new Map();
  try {
    mrs = await developmentMRs(openNonEpics.map((iss) => `gid://gitlab/WorkItem/${iss.id}`));
  } catch {
    /* sin widget Development: cargan sin MR */
  }
  for (const iss of mapped) {
    if (iss.isEpic) iss.mrs = [];
    else if (iss.state === "closed") {
      iss.mrs = [];
      iss.mrsPending = true; // closing + related se piden al mostrar cerradas
    } else {
      iss.mrs = mrs.get(`gid://gitlab/WorkItem/${iss.id}`) || []; // ya tiene las de cierre
      iss.relatedPending = true; // las referenciadas (1 query/issue) se traen en 2º plano
    }
  }
  return mapped;
}

// Issues de UN proyecto suelto (no del grupo): para la vista de Incidencias, que apunta a un
// proyecto que puede vivir en otro namespace (p.ej. soporte/incidencias, fuera del grupo de
// milestones). Trae abiertas + cerradas; el filtrado (etiqueta, estado) es de visualización.

async function projectIssues(projectPath) {
  const enc = proj(projectPath);
  const issues = await apiAll(`/projects/${enc}/issues?state=all&with_labels_details=true&scope=all`);
  return issues.map(mapIssue);
}

// MRs (cierre + referenciadas) de un conjunto de work items por id, bajo demanda. Para las issues
// cerradas cuando el usuario activa "Mostrar cerradas". Devuelve { [id]: [{webUrl,state,title}] }.

async function issueMRs(workItemIds) {
  const ids = (workItemIds || []).map(String);
  const map = await developmentMRs(ids.map((id) => `gid://gitlab/WorkItem/${id}`), { withRelated: true });
  const out = {};
  for (const id of ids) out[id] = map.get(`gid://gitlab/WorkItem/${id}`) || [];
  return out;
}

// Tareas hijas de UNA Epic (issue) con sus MRs (cierre + referenciadas), bajo demanda al desplegar
// el caret. Devuelve [] si no tiene hijos o la instancia no expone la jerarquía.

async function milestoneEpicChildren(workItemId) {
  const gid = `gid://gitlab/WorkItem/${workItemId}`;
  const map = await workItemChildren([gid]);
  const children = map.get(gid) || [];
  if (children.length) {
    const mrs = await developmentMRs(children.map((c) => c.gid), { withRelated: true });
    for (const c of children) c.mrs = mrs.get(c.gid) || [];
  }
  return children;
}

// Aplica fn a cada item con concurrencia limitada (las related van 1 query por work item: sin tope
// dispararíamos decenas de requests a la vez). Conserva el orden de entrada en el resultado.

const MR_RANK = { opened: 0, merged: 1, locked: 2, closed: 3 };

// MRs que CIERRAN cada work item (widget Development), en lotes paralelos. Devuelve Map<gid,[mr]>.
// Es lo barato: closingMergeRequests SÍ admite batch (a diferencia de relatedMergeRequests).

async function closingMRs(gids) {
  const out = new Map();
  const build = (batch) =>
    batch
      .map(
        (gid, i) =>
          `a${i}: workItem(id:${JSON.stringify(gid)}){ widgets{ ... on WorkItemWidgetDevelopment {
            closingMergeRequests { nodes { mergeRequest { webUrl state title } } }
          } } }`,
      )
      .join("\n");
  const runBatch = async (batch) => {
    let data;
    try {
      data = await graphql(`query{ ${build(batch)} }`);
    } catch (e) {
      console.error("[monstro] closingMRs lote falló:", e.message);
      return batch.map((gid) => [gid, []]);
    }
    return batch.map((gid, i) => {
      const widget = (data?.[`a${i}`]?.widgets || []).find((w) => w && "closingMergeRequests" in w);
      const list = [];
      for (const n of widget?.closingMergeRequests?.nodes || []) if (n.mergeRequest) list.push(n.mergeRequest);
      return [gid, list];
    });
  };
  const batches = await Promise.all(chunk(gids, 15).map(runBatch));
  for (const entries of batches) for (const [gid, mrs] of entries) out.set(gid, mrs);
  return out;
}

// MRs solo-referenciadas (no de cierre) de UN work item. GitLab limita relatedMergeRequests a
// 1 work item por query, así que va de uno en uno (úsalo solo con pocos: hijos de una Epic).

async function relatedMRsOne(gid) {
  try {
    const data = await graphql(
      `query{ wi: workItem(id:${JSON.stringify(gid)}){ widgets{ ... on WorkItemWidgetDevelopment { relatedMergeRequests { nodes { webUrl state title } } } } } }`,
    );
    const widget = (data?.wi?.widgets || []).find((w) => w && "relatedMergeRequests" in w);
    return (widget?.relatedMergeRequests?.nodes || []).filter(Boolean);
  } catch (e) {
    console.error("[monstro] relatedMRsOne falló:", e.message);
    return [];
  }
}

// MRs del apartado Development de varios work items. Por defecto SOLO las de cierre (rápido, batch).
// Con {withRelated:true} añade las solo-referenciadas (1 query por work item — GitLab no deja batch);
// usar solo con pocos (hijos de una Epic al desplegar). Devuelve Map<gid,[{webUrl,state,title}]>.

async function developmentMRs(gids, { withRelated = false } = {}) {
  const closing = await closingMRs(gids);
  const related = withRelated ? await mapLimit(gids, 8, relatedMRsOne) : [];
  const out = new Map();
  gids.forEach((gid, i) => {
    const list = [...(closing.get(gid) || []), ...(withRelated ? related[i] : [])];
    const seen = new Set();
    const deduped = list.filter((mr) => mr.webUrl && !seen.has(mr.webUrl) && seen.add(mr.webUrl));
    deduped.sort((a, b) => (MR_RANK[a.state] ?? 9) - (MR_RANK[b.state] ?? 9)); // abiertas primero
    out.set(gid, deduped);
  });
  return out;
}

// Tareas hijas (work items) de varias Epics. Devuelve Map<gid, [child]> con cada hijo normalizado a
// la forma de issue del board: {gid, iid, title, state("opened"|"closed"), webUrl, labels}.
// En lotes pequeños (el connection de hijos + labels anidados pesa) y tolerante a fallo por lote.

async function workItemChildren(gids) {
  const out = new Map();
  const build = (batch) =>
    batch
      .map(
        (gid, i) =>
          `a${i}: workItem(id:${JSON.stringify(gid)}){ widgets{
            ... on WorkItemWidgetHierarchy { children { nodes {
              id iid title state webUrl
              widgets { ... on WorkItemWidgetLabels { labels { nodes { title color textColor } } } }
            } } }
          } }`,
      )
      .join("\n");
  for (const batch of chunk(gids, 8)) {
    let data;
    try {
      data = await graphql(`query{ ${build(batch)} }`);
    } catch (e) {
      console.error("[monstro] workItemChildren lote falló:", e.message);
      for (const gid of batch) out.set(gid, []);
      continue;
    }
    batch.forEach((gid, i) => {
      const widget = (data?.[`a${i}`]?.widgets || []).find((w) => w && "children" in w);
      const children = (widget?.children?.nodes || []).map((c) => {
        const labelsWidget = (c.widgets || []).find((w) => w && "labels" in w);
        return {
          gid: c.id,
          iid: c.iid,
          title: c.title,
          state: String(c.state).toLowerCase().includes("clos") ? "closed" : "opened",
          webUrl: c.webUrl,
          labels: (labelsWidget?.labels?.nodes || []).map((l) => ({ name: l.title, color: l.color, textColor: l.textColor })),
          mrs: [],
        };
      });
      out.set(gid, children);
    });
  }
  return out;
}

// Descarga un avatar (privado, requiere token) y lo devuelve como data-URI para que el renderer
// pueda pintarlo (las imágenes /uploads/-/system de una instancia privada dan 401 sin auth).

async function groupProjects() {
  const group = milestonesGroup();
  if (!group) return [];
  const projects = await apiAll(`/groups/${encodeURIComponent(group)}/projects?include_subgroups=true`);
  return Promise.all(
    projects.map(async (p) => ({
      id: p.id,
      path: p.path_with_namespace,
      name: p.name,
      archived: Boolean(p.archived),
      icon: p.avatar_url ? await fetchAvatarDataUri(p.avatar_url) : null,
    })),
  );
}

// Labels del grupo, para poder asignar cualquiera (no solo las de estado configuradas).

async function groupLabels() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const labels = await apiAll(`/groups/${encodeURIComponent(group)}/labels?with_counts=false`);
  return labels.map((l) => ({ name: l.name, color: l.color, textColor: l.text_color }));
}

// Edita un issue (etiquetas / milestone / asignados). Los issues se leen del grupo
// pero las mutaciones van por proyecto. NO es atómico entre varios issues: el llamador
// (renderer) aplica en serie y reporta; un fallo a medias deja unos hechos y otros no.
// patch: { addLabels?, removeLabels?, milestoneId?, assigneeIds? }.

async function updateIssue(projectId, iid, patch) {
  const body = {};
  if (patch.addLabels?.length) body.add_labels = patch.addLabels.join(",");
  if (patch.removeLabels?.length) body.remove_labels = patch.removeLabels.join(",");
  // milestone_id: 0 desasigna el milestone; un id real lo asigna (los de grupo valen).
  if ("milestoneId" in patch) body.milestone_id = patch.milestoneId == null ? 0 : patch.milestoneId;
  if (patch.assigneeIds) body.assignee_ids = patch.assigneeIds.length ? patch.assigneeIds : [0];
  if (patch.stateEvent) body.state_event = patch.stateEvent; // "close" / "reopen"
  const updated = await api("PUT", `/projects/${projectId}/issues/${iid}`, body);
  return mapIssue(updated);
}

// Crea una issue en un proyecto. Devuelve {iid, projectPath, url, title} (forma mínima que consume
// el flujo de Trabajo local; no normaliza a la forma de PR porque una issue no es una MR).

async function createIssue(repoFullName, { title, description, labels, milestoneId, assigneeIds }) {
  const body = { title };
  if (description) body.description = description;
  if (labels?.length) body.labels = labels.join(",");
  if (milestoneId) body.milestone_id = milestoneId;
  if (assigneeIds?.length) body.assignee_ids = assigneeIds;
  const issue = await api("POST", `/projects/${proj(repoFullName)}/issues`, body);
  return { iid: issue.iid, projectPath: repoFullName, projectId: issue.project_id, url: issue.web_url, title: issue.title };
}

// Vincula `targetIid` (en targetProjectId) como linked item de la issue iid. target_project_id acepta
// id numérico o path URL-encoded. Best-effort para el flujo de Epic (no debe tumbar la creación).

async function createIssueLink(projectPath, iid, targetProjectId, targetIid) {
  return api("POST", `/projects/${proj(projectPath)}/issues/${iid}/links`, { target_project_id: targetProjectId, target_issue_iid: targetIid });
}

// Estado en vivo de una MR / issue para el histórico (#4b).

async function mrStatus(projectPath, iid) {
  const mr = await api("GET", `/projects/${proj(projectPath)}/merge_requests/${iid}`);
  return { state: mr.state, merged: mr.state === "merged" };
}

async function issueStatus(projectPath, iid) {
  const it = await api("GET", `/projects/${proj(projectPath)}/issues/${iid}`);
  return { state: it.state, closed: it.state === "closed", labels: it.labels || [] };
}

// Crea una Merge Request sourceBranch -> targetBranch. squash:false y remove_source_branch:false
// por decisión de producto (merge = merge commit, nunca squash). Devuelve forma mínima para que el
// renderer pueda enlazar a la vista de MRs (projectPath + number) y abrir el web_url.

async function createEpic({ title, description, labels, milestoneId, assigneeIds }) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para epics (revisa repos o config.milestones.group).");
  return createIssue(`${group}/epics`, { title, description, labels, milestoneId, assigneeIds });
}

// Busca issues abiertas en el grupo (incluye las del proyecto `epics` = epics) para el flujo de
// Vincular tarea. Devuelve forma mínima: {iid, projectPath, title, url, isEpic}. projectPath sale de
// references.full ("group/proj#iid") porque el endpoint de grupo solo trae project_id numérico.

async function searchGroupIssues(query) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado (revisa repos o config.milestones.group).");
  const q = encodeURIComponent(String(query || "").trim());
  const issues = await api("GET", `/groups/${encodeURIComponent(group)}/issues?search=${q}&state=opened&order_by=updated_at&per_page=20`);
  return (Array.isArray(issues) ? issues : []).map((it) => ({
    iid: it.iid,
    projectPath: (it.references?.full || "").split("#")[0] || null,
    title: it.title,
    url: it.web_url,
    isEpic: isEpicUrl(it.web_url),
  }));
}

// Tareas (issues abiertas del grupo) asignadas al usuario, para el flujo "Empezar tarea" (OPE-20).
// Devuelve la forma mínima + `labels` y `priority` para que el renderer ordene por prioridad y
// oculte por defecto las terminadas (pending check / finished). El estado closed ya se excluye con
// state=opened; el filtrado fino por etiqueta lo hace el renderer (filtros habituales encima).

async function listMyTasks() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado (revisa repos o config.milestones.group).");
  const me = await viewer();
  const issues = await apiAll(
    `/groups/${encodeURIComponent(group)}/issues?scope=all&assignee_username=${encodeURIComponent(me.login)}&state=opened&order_by=updated_at`,
  );
  return (Array.isArray(issues) ? issues : []).map((it) => {
    const labels = Array.isArray(it.labels) ? it.labels : [];
    const lower = labels.map((l) => l.toLowerCase());
    const priority = lower.includes("high priority") ? 0 : lower.includes("medium priority") ? 1 : lower.includes("low priority") ? 2 : 3;
    return {
      iid: it.iid,
      projectPath: (it.references?.full || "").split("#")[0] || null,
      title: it.title,
      description: it.description || "",
      url: it.web_url,
      isEpic: isEpicUrl(it.web_url),
      labels,
      priority,
    };
  });
}

// Las Epics viven como issues en el proyecto "epics" del grupo: las detectamos por el último
// segmento del path del proyecto en su URL.
// ponytail: nombre de proyecto "epics" hardcodeado; si vuestra instancia lo llama distinto,
// parametrizar en config.milestones.epicsProject.

function isEpicUrl(webUrl) {
  const path = (webUrl || "").replace(/\/-\/(issues|work_items)\/\d+.*$/, "");
  return path.split("/").pop()?.toLowerCase() === "epics";
}

// Consulta GraphQL contra /api/graphql (REST no expone la jerarquía padre de work items).

async function workItemParents(gids) {
  if (!gids.length) return new Map();
  const fields = gids
    .map((gid, i) => `a${i}: workItem(id:${JSON.stringify(gid)}){ widgets{ ... on WorkItemWidgetHierarchy { parent { id title webUrl workItemType { name } } } } }`)
    .join("\n");
  const data = await graphql(`query{ ${fields} }`);
  const out = new Map();
  gids.forEach((gid, i) => {
    const node = data?.[`a${i}`];
    const widget = (node?.widgets || []).find((w) => w && "parent" in w);
    out.set(gid, widget?.parent || null);
  });
  return out;
}

// Colapsa la jerarquía para el resumen: cada work item de tipo "task" SUBE a su ancestro no-task
// más cercano (normalmente la Epic —issue del proyecto "epics"—, a veces un issue padre); los
// issues normales se quedan como están. Los items que comparten ancestro se funden en uno (los
// títulos de sus hijos quedan como contexto para la IA). Las tasks sin ancestro no-task se
// DESCARTAN: nunca deben aparecer en el resumen. Solo GitLab (github tiene stub de paridad).
// ponytail: subida nivel a nivel en lotes (1-2 requests GraphQL); si la jerarquía fuese muy
// profunda subiría el nº de niveles, no el de requests.

async function collapseMilestoneEpics(issues) {
  const list = Array.isArray(issues) ? issues : [];
  // Estado por item: arranca en sí mismo; los "issue" ya están resueltos, los "task" deben subir.
  const states = list.map((iss) => ({
    done: iss.issueType !== "task",
    orphan: false,
    gid: `gid://gitlab/WorkItem/${iss.id}`,
    title: iss.title,
    url: iss.webUrl,
  }));
  for (let level = 0; level < 6; level++) {
    const pending = states.filter((s) => !s.done && !s.orphan);
    if (!pending.length) break;
    let parents;
    try {
      parents = await workItemParents(pending.map((s) => s.gid));
    } catch {
      // Sin GraphQL no podemos subir: descartamos las tasks pendientes (nunca deben colarse).
      for (const s of pending) s.orphan = true;
      break;
    }
    for (const s of pending) {
      const parent = parents.get(s.gid);
      if (!parent) {
        s.orphan = true; // task sin padre
        continue;
      }
      s.gid = parent.id;
      s.title = parent.title;
      s.url = parent.webUrl;
      if ((parent.workItemType?.name || "").toLowerCase() !== "task") s.done = true;
    }
  }

  const byUrl = new Map();
  const items = [];
  list.forEach((iss, i) => {
    const s = states[i];
    if (s.orphan || !s.done) return; // task descartada (sin ancestro no-task)
    let item = byUrl.get(s.url);
    if (!item) {
      item = { kind: isEpicUrl(s.url) ? "epic" : "issue", title: s.title, url: s.url, children: [], labels: [], desc: "" };
      byUrl.set(s.url, item);
      items.push(item);
    }
    if (s.url === iss.webUrl) {
      // El representante es el propio item: aporta sus etiquetas/descripción como contexto.
      item.labels = (iss.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      item.desc = iss.descriptionHtml || "";
    } else {
      // Un hijo (task) subió hasta este ancestro: su título da contexto a la IA.
      item.children.push(iss.title);
    }
  });
  return items;
}

/**
 * Crea un snippet personal de GitLab con el resumen en Markdown y devuelve su URL
 * compartible. GitLab renderiza el .md (enlaces y refs vivos), así el correo pasa de
 * pegar títulos a pegar UN enlace. Visibilidad `internal`: cualquiera logueado en la
 * instancia puede verlo (no público, no privado al autor). Solo GitLab.
 */

async function createSnippet({ title, contentMarkdown }) {
  const snippet = await api("POST", "/snippets", {
    title: title || "Novedades",
    visibility: "internal",
    files: [{ file_path: "novedades.md", content: contentMarkdown || "" }],
  });
  return { url: snippet.web_url };
}

// Marcadores del bloque que gestiona Monstro dentro de la descripción del milestone: todo lo que
// haya escrito una persona fuera de ellos se conserva; el bloque se reemplaza entero al regenerar.

const SUMMARY_START = "<!-- monstro:summary:start -->";

const SUMMARY_END = "<!-- monstro:summary:end -->";

function mergeSummaryBlock(description, contentMarkdown) {
  const block = `${SUMMARY_START}\n${contentMarkdown.trim()}\n${SUMMARY_END}`;
  const start = description.indexOf(SUMMARY_START);
  const end = description.indexOf(SUMMARY_END);
  if (start === -1 || end === -1 || end < start) return description.trim() ? `${description.trim()}\n\n${block}\n` : `${block}\n`;
  return `${description.slice(0, start)}${block}${description.slice(end + SUMMARY_END.length)}`;
}

/**
 * Espeja el resumen (enlace al snippet + contenido) en la descripción del milestone de grupo.
 * Resuelve el milestone por título en el backend (el renderer no manda ids) y hace el PUT sobre
 * SU grupo, no sobre el configurado: con `include_ancestors=true` el milestone puede vivir en un
 * grupo padre y el PUT al hijo daría 404. Solo GitLab.
 */

async function saveMilestoneSummary({ milestoneTitle, contentMarkdown }) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const ms = await apiAll(`/groups/${encodeURIComponent(group)}/milestones?state=active&include_ancestors=true`);
  const found = ms.find((m) => m.title === milestoneTitle);
  if (!found) throw new Error(`No se encontró el milestone "${milestoneTitle}" en el grupo ${group}.`);
  const updated = await api("PUT", `/groups/${found.group_id}/milestones/${found.id}`, {
    description: mergeSummaryBlock(found.description || "", contentMarkdown || ""),
  });
  return { url: updated.web_url };
}

module.exports = {
  MR_RANK,
  SUMMARY_END,
  SUMMARY_START,
  closingMRs,
  collapseMilestoneEpics,
  createEpic,
  createIssue,
  createIssueLink,
  createSnippet,
  developmentMRs,
  groupLabels,
  groupProjects,
  isEpicUrl,
  issueMRs,
  issueStatus,
  listMilestones,
  listMyTasks,
  mapAssignee,
  mapIssue,
  mapMilestone,
  mergeSummaryBlock,
  milestoneEpicChildren,
  milestoneIssues,
  milestonesGroup,
  mrStatus,
  projectIssues,
  relatedMRsOne,
  saveMilestoneSummary,
  searchGroupIssues,
  updateIssue,
  workItemChildren,
  workItemParents,
};
