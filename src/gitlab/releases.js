"use strict";

// releases: generar ramas rb/, AppDate de Ouicare, tags+releases por proyecto, pipelines y jobs.
// Parte de la implementación del proveedor GitLab — ver src/gitlab.js para la interfaz pública.

const config = require("../config");
const { api, mapPipeline, proj } = require("./core");

function releaseDefaults() {
  const cfg = config.load();
  return {
    sourceBranch: cfg.releases?.sourceBranch || "development",
    branchPrefix: cfg.releases?.branchPrefix || "rb/",
    // Selección por defecto (ids) y última recordada (paths) para que la vista la siembre/restaure.
    defaultProjectIds: Array.isArray(cfg.releases?.defaultProjectIds) ? cfg.releases.defaultProjectIds.map(String) : [],
    selectedProjects: Array.isArray(cfg.releases?.selectedProjects) ? cfg.releases.selectedProjects : null,
    ouicare: cfg.releases?.ouicare || null,
  };
}

/**
 * Actualiza la appSetting `AppDate` del Web.config de Ouicare (cache-buster del appcache: el valor
 * alimenta el "App Markup Date" del CACHE MANIFEST, así que hay que bumpearlo en cada release) y la
 * commitea en `sourceBranch` ANTES de crear la release branch — réplica del paso manual del script
 * ("Change AppDate in Ouicare before creating branch"). `date` = "DDMMYYYY". Si ya vale eso, no
 * commitea (GitLab rechaza commits sin cambios). NO lanza: devuelve {ok, skipped?, error?, date}.
 */

async function updateOuicareAppDate({ projectPath, webConfigPath, appDateKey }, sourceBranch, date) {
  try {
    if (!projectPath || !webConfigPath || !appDateKey) return { ok: false, error: "Ouicare sin configurar" };
    const fileApi = `/projects/${proj(projectPath)}/repository/files/${encodeURIComponent(webConfigPath)}`;
    const file = await api("GET", `${fileApi}?ref=${encodeURIComponent(sourceBranch)}`);
    const content = Buffer.from(file.content, "base64").toString("utf8");
    // <add key="AppDate" value="04022026"/> (comillas dobles, key antes que value, cierre con o sin espacio)
    const re = new RegExp(`(<add\\s+key="${appDateKey}"\\s+value=")([^"]*)("\\s*/>)`, "i");
    const m = content.match(re);
    if (!m) return { ok: false, error: `No se encontró la clave ${appDateKey} en ${webConfigPath}` };
    if (m[2] === date) return { ok: true, skipped: true, date, previous: m[2] };
    const next = content.replace(re, `$1${date}$3`);
    await api("POST", `/projects/${proj(projectPath)}/repository/commits`, {
      branch: sourceBranch,
      commit_message: `chore(ouicare): AppDate ${date} (release)`,
      actions: [{ action: "update", file_path: webConfigPath, content: next }],
    });
    return { ok: true, date, previous: m[2] };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/**
 * Crea la(s) release branch(es) `${branchPrefix}${version}[-mx]` en cada proyecto pedido, a partir de
 * `sourceBranch` (POST repository/branches con {branch, ref}). Replica auto-rb-branches.py.
 * `projects` = [{id,name}] donde id = path (o id numérico) del proyecto en el grupo. `variant` =
 * "es" | "mx" | "both": España es la rama sin sufijo, México es la misma + `-mx` (así lo tenéis
 * asociado a los despliegues; en GitLab TODAS las rb/ van en pareja rb/x + rb/x-mx). Ambas salen de
 * la MISMA rama origen. Si `ouicare` viene con {enabled,date,...}, antes de ramificar se actualiza el
 * AppDate en la rama origen. NO atómico entre N proyectos × M variantes: se aplican en serie y se
 * reporta por-entrada {id,name,branch,ok,error?,webUrl?}; un fallo a medias deja unas creadas y otras
 * no (igual que cherryPick). El token NUNCA se hardcodea (a diferencia del script legacy). Solo GitLab.
 */

async function generateReleaseBranches({ projects, version, sourceBranch, variant, ouicare }) {
  const prefix = releaseDefaults().branchPrefix;
  const suffixes = variant === "both" ? ["", "-mx"] : variant === "mx" ? ["-mx"] : [""];
  const branches = suffixes.map((s) => `${prefix}${version}${s}`);
  const ref = sourceBranch || releaseDefaults().sourceBranch;
  // Paso previo: AppDate de Ouicare en la rama origen, para que las nuevas ramas ya lo hereden.
  const appDate = ouicare && ouicare.enabled ? await updateOuicareAppDate(ouicare, ref, ouicare.date) : null;
  const results = [];
  for (const p of projects || []) {
    for (const branch of branches) {
      try {
        const created = await api("POST", `/projects/${proj(String(p.id))}/repository/branches`, { branch, ref });
        results.push({ id: p.id, name: p.name || String(p.id), branch, ok: true, webUrl: created.web_url || null });
      } catch (err) {
        results.push({ id: p.id, name: p.name || String(p.id), branch, ok: false, error: String(err.message || err) });
      }
    }
  }
  return { branches, ref, appDate, results };
}

/* ---------- publicar releases (tag + release por proyecto) ---------- */

/**
 * Siguiente tag CalVer para un proyecto dado un `base` (p.ej. "2026.06") y un `suffix` opcional
 * ("-mx" para México, "" para España): mira las releases existentes, busca los tags
 * `^<base>\.(\d+)<suffix>$` y devuelve `<base>.<max+1><suffix>` (o `<base>.0<suffix>` si no hay).
 * El patch se autoincrementa POR PROYECTO y el contador de España y México es INDEPENDIENTE
 * (2026.07.0 y 2026.07.0-mx no chocan), igual que el histórico `042026-1.1.3` / `042026-1.1.3-mx`.
 */

async function nextReleaseTag(projectId, base, suffix = "") {
  const releases = await api("GET", `/projects/${proj(String(projectId))}/releases?per_page=100`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(base)}\\.(\\d+)${esc(suffix)}$`);
  let max = -1;
  for (const r of releases || []) {
    const m = (r.tag_name || "").match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base}.${max + 1}${suffix}`;
}

/**
 * Publica una release (tag + release en UNA llamada: POST /releases crea el tag si no existe) en
 * cada proyecto. `ref` = la rama rb/… de la que se publica; `base` = CalVer "AAAA.MM" (el patch lo
 * resuelve nextReleaseTag por proyecto). `milestones` = array de TÍTULOS (la API los acepta de
 * proyecto o de grupo ancestro). NO atómico entre N proyectos (igual que generateReleaseBranches):
 * se aplica en serie y se reporta por-proyecto {id,name,ok,tag,releaseUrl?,error?}. Solo GitLab.
 */

async function createReleases({ projects, ref, base, milestones, description, name }) {
  // Variante México: si la rama de release acaba en `-mx`, el tag hereda el sufijo (así lo tenéis
  // asociado a los despliegues). El contador del patch es independiente del de España (ver nextReleaseTag).
  const suffix = /-mx$/i.test(ref || "") ? "-mx" : "";
  const results = [];
  for (const p of projects || []) {
    try {
      const tag = await nextReleaseTag(p.id, base, suffix);
      const body = { tag_name: tag, ref };
      if (Array.isArray(milestones) && milestones.length) body.milestones = milestones;
      if (description) body.description = description;
      body.name = name ? name.replace(/\{tag\}/g, tag) : tag;
      const created = await api("POST", `/projects/${proj(String(p.id))}/releases`, body);
      results.push({ id: p.id, name: p.name || String(p.id), ok: true, tag, releaseUrl: created._links?.self || null });
    } catch (err) {
      results.push({ id: p.id, name: p.name || String(p.id), ok: false, error: String(err.message || err) });
    }
  }
  return { base, ref, milestones: milestones || [], results };
}

/**
 * Estado de despliegue de un proyecto para un ref/tag: pipeline (estado normalizado a la forma
 * GitHub vía mapPipeline) + entornos. Para "saber si se ha desplegado correctamente esta versión".
 * NO lanza: cada parte se captura por separado y cae a null/[] para que el panel sea estable.
 */

async function releaseStatus(projectId, ref) {
  const id = proj(String(projectId));
  let pipeline = null;
  try {
    const pipes = await api("GET", `/projects/${id}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`);
    const p = (pipes || [])[0];
    if (p) pipeline = { state: mapPipeline({ status: p.status })?.state || "EXPECTED", webUrl: p.web_url || null };
  } catch {
    pipeline = null;
  }
  let environments = [];
  try {
    const envs = await api("GET", `/projects/${id}/environments?per_page=20`);
    // Solo nombre/estado: es lo único que pinta el panel de Publicar. (El listado de entornos NO
    // devuelve `last_deployment` — solo el detalle por entorno; ver projectEnvironments.)
    environments = (envs || []).map((e) => ({
      name: e.name,
      state: e.state, // "available" | "stopped"
      webUrl: e.external_url || null,
    }));
  } catch {
    environments = [];
  }
  return { pipeline, environments };
}

// Orden de columnas de la vista de Entornos: por tier (lo pronto primero), luego alfabético. GitLab
// devuelve los entornos en orden de creación, que no dice nada al mirarlos en una matriz.

async function releasePipeline(projectId, ref) {
  const id = proj(String(projectId));
  // Una sola llamada para el selector de releases.
  const rels = await api("GET", `/projects/${id}/releases?per_page=20`);
  const releases = (rels || []).map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    createdAt: r.released_at || r.created_at || null,
    webUrl: r._links?.self || null,
  }));
  // Con `ref` explícito mandas tú (has elegido esa release en el selector). Sin él NO vale quedarse
  // con la más reciente: hay proyectos cuyo CI publica una release por cada push a `rb/*` (tags
  // `rama/timestamp` de release-cli) que no disparan pipeline ninguna, y como esas son siempre las
  // más nuevas la vista se quedaba clavada en "esta release no tiene pipeline" para siempre.
  // Probamos las siguientes hasta dar con una que sí tenga. Tope de 5: en el peor caso son 5
  // llamadas y sobra para atravesar la racha de tags automáticos.
  const candidates = ref ? [ref] : releases.slice(0, 5).map((r) => r.tag).filter(Boolean);
  let tag = ref || releases[0]?.tag || null;
  let pipeline = null;
  for (const candidate of candidates) {
    const found = await pipelineFor(id, candidate);
    if (!found) continue;
    tag = candidate;
    pipeline = found;
    break;
  }
  return { releases, tag, pipeline };
}

/**
 * La pipeline de un tag concreto con sus jobs, o null si no la hay. Devuelve null también si la
 * llamada falla: un tag problemático no debe tumbar la fila entera — el llamante prueba el siguiente.
 */
async function pipelineFor(id, tag) {
  if (!tag) return null;
  try {
    const pipes = await api("GET", `/projects/${id}/pipelines?ref=${encodeURIComponent(tag)}&per_page=1`);
    const p = (pipes || [])[0];
    if (!p) return null;
    const jobsRaw = await api("GET", `/projects/${id}/pipelines/${p.id}/jobs?per_page=100`).catch(() => []);
    const jobs = (jobsRaw || []).map((j) => ({
      id: j.id,
      name: j.name,
      stage: j.stage,
      status: j.status, // GitLab raw (success/failed/manual/running/…): el renderer lo mapea a icono.
      manual: j.status === "manual",
      webUrl: j.web_url || null,
    }));
    return { id: p.id, state: mapPipeline({ status: p.status })?.state || "EXPECTED", webUrl: p.web_url || null, jobs };
  } catch {
    return null;
  }
}

/** Lanza un job manual de CI (▶). Devuelve el job actualizado. Solo GitLab. */

async function playJob(projectId, jobId) {
  const id = proj(String(projectId));
  const j = await api("POST", `/projects/${id}/jobs/${encodeURIComponent(String(jobId))}/play`);
  return { id: j.id, name: j.name, status: j.status, webUrl: j.web_url || null };
}

/** GitLab revierte creando un commit directo en la rama destino (no abre MR). */

module.exports = {
  createReleases,
  generateReleaseBranches,
  nextReleaseTag,
  playJob,
  releaseDefaults,
  releasePipeline,
  releaseStatus,
  updateOuicareAppDate,
};
