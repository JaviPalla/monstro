"use strict";

// Handlers IPC de releases: ramas rb/, tags, estado, pipelines y jobs.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const provider = require("../provider");

const gh = () => provider.current();

function register() {
  ipcMain.handle("releases:defaults", async () => gh().releaseDefaults());
  ipcMain.handle("releases:generate", async (_event, { version, sourceBranch, projects, variant, ouicare }) => {
    const { branchPrefix, sourceBranch: defSource, ouicare: cfgOuicare } = await gh().releaseDefaults();
    const v = typeof version === "string" ? version.trim() : "";
    if (!v) throw new Error("Falta el nombre de versión");
    const vr = ["es", "mx", "both"].includes(variant) ? variant : "es";
    // Validamos el nombre de rama FINAL (prefijo + versión, y la variante -mx si aplica) con la misma
    // regla que el resto de ramas.
    if (!BRANCH_RE.test(`${branchPrefix}${v}`)) throw new Error("Nombre de versión no válido");
    if (vr !== "es" && !BRANCH_RE.test(`${branchPrefix}${v}-mx`)) throw new Error("Nombre de versión no válido");
    const src = typeof sourceBranch === "string" && sourceBranch.trim() ? sourceBranch.trim() : defSource;
    if (!BRANCH_RE.test(src)) throw new Error("Rama origen no válida");
    // Los proyectos los elige el renderer del grupo (paths). Validamos el FORMATO del id (path
    // anidado o id numérico); los permisos del token en GitLab son el límite real de a qué proyecto
    // se puede escribir. ponytail: no re-fetch del grupo solo para validar (groupProjects proxea
    // avatares = caro); path-format + perms bastan.
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    const selected = (projects || [])
      .filter((p) => p && typeof p.id === "string" && PATH_RE.test(p.id))
      .map((p) => ({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id }));
    if (!selected.length) throw new Error("No hay proyectos seleccionados");
    // Ouicare AppDate: projectPath/webConfigPath/appDateKey salen de CONFIG (no del renderer);
    // del renderer solo enabled + date (DDMMYYYY, validada aquí).
    let ouicareArg = null;
    if (ouicare && ouicare.enabled && cfgOuicare) {
      const date = typeof ouicare.date === "string" ? ouicare.date : "";
      if (!/^\d{8}$/.test(date)) throw new Error("Fecha de AppDate no válida (DDMMYYYY)");
      ouicareArg = { ...cfgOuicare, enabled: true, date };
    }
    return gh().generateReleaseBranches({ projects: selected, version: v, sourceBranch: src, variant: vr, ouicare: ouicareArg });
  });

  // Publicar release (tag + release) en N proyectos. Misma filosofía de validación que generate:
  // no confiamos en el renderer, validamos formato; los permisos del token son el límite real.
  ipcMain.handle("releases:create", async (_event, { projects, ref, base, milestones, description, name }) => {
    if (typeof base !== "string" || !/^\d{4}\.\d{2}$/.test(base)) throw new Error("Versión CalVer no válida (AAAA.MM)");
    if (typeof ref !== "string" || !BRANCH_RE.test(ref)) throw new Error("Rama de release no válida");
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    const selected = (projects || [])
      .filter((p) => p && typeof p.id === "string" && PATH_RE.test(p.id))
      .map((p) => ({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id }));
    if (!selected.length) throw new Error("No hay proyectos seleccionados");
    const ms = Array.isArray(milestones) ? milestones.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [];
    const desc = typeof description === "string" ? description.slice(0, 10000) : "";
    const nm = typeof name === "string" ? name.slice(0, 200) : "";
    return gh().createReleases({ projects: selected, ref, base, milestones: ms, description: desc, name: nm });
  });
  ipcMain.handle("releases:status", async (_event, { projectId, ref }) => {
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    if (typeof projectId !== "string" || !PATH_RE.test(projectId)) throw new Error("Proyecto no válido");
    if (typeof ref !== "string" || !BRANCH_RE.test(ref)) throw new Error("Ref no válida");
    return gh().releaseStatus(projectId, ref);
  });
  // Pipelines de despliegue por proyecto, ancladas a sus releases (OPE-25). `ref` opcional (tag de
  // una release anterior); si no se pasa, el backend usa la última release. Validamos formato.
  ipcMain.handle("releases:pipeline", async (_event, { projectId, ref }) => {
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    if (typeof projectId !== "string" || !PATH_RE.test(projectId)) throw new Error("Proyecto no válido");
    const tag = typeof ref === "string" && ref.trim() ? ref.trim() : null;
    if (tag && !BRANCH_RE.test(tag)) throw new Error("Ref no válida");
    return gh().releasePipeline(projectId, tag);
  });
  // Lanzar un job manual de CI. El job_id es numérico; los permisos del token son el límite real.
  ipcMain.handle("releases:playJob", async (_event, { projectId, jobId }) => {
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    if (typeof projectId !== "string" || !PATH_RE.test(projectId)) throw new Error("Proyecto no válido");
    if (!/^\d+$/.test(String(jobId))) throw new Error("Job no válido");
    return gh().playJob(projectId, jobId);
  });

  // Entornos de un proyecto + su último despliegue (capa 1 de la vista de Entornos). Solo GitLab.
}

module.exports = { register };
