"use strict";

// Handlers IPC de "Probar en local" (ficha de Agents): de una sesión de Claude Code saca qué proyectos
// tocan sus MRs y sus worktrees, los levanta en este Mac (una pestaña de Ghostty por proyecto) y sondea
// cómo van. La lógica pura vive en src/local-run.js. Se registran desde wireIpc().

const { ipcMain } = require("electron");
const fs = require("fs");
const config = require("../config");
const local = require("../local");
const localRun = require("../local-run");
const { agentWorktree } = require("../sessions");
const sessionsIpc = require("./sessions");

const PROJECT_RE = /^[\w.-]+(\/[\w.-]+)+$/;

// Proyectos de la sesión: los de sus MRs/PRs + los de sus repos/worktrees, sin repetir. Cada uno con la
// carpeta donde arrancarlo: la que ya usa la sesión, un worktree que ya exista de la rama de la MR, o el
// clon (marcando que el worktree se creará al arrancar — `plan` es solo lectura).
// Los motivos y avisos salen como `{ code, ...params }`: la lista vive en src/local-run.js (CODES).
async function entriesFor(s) {
  const clones = await local.scanRepos(config.load().local.rootDir).catch(() => []);
  const byProject = new Map();
  for (const r of s.repos) {
    // `clone` aunque la sesión ya tenga carpeta: de ahí salen el .env y demás ficheros que git ignora.
    if (r.project && r.dir && !byProject.has(r.project)) {
      byProject.set(r.project, { project: r.project, base: r.dir, branch: r.branch || null, clone: clones.find((c) => c.gitlabPath === r.project)?.dir || null, worktree: agentWorktree(r.dir) });
    }
  }
  for (const link of s.links.filter((l) => l.kind === "mr" || l.kind === "pr")) {
    if (byProject.has(link.project)) continue; // la sesión ya trabaja en ese repo: esa carpeta manda
    const clone = clones.find((c) => c.gitlabPath === link.project)?.dir || null;
    if (!clone) {
      byProject.set(link.project, { project: link.project, base: null, branch: null, blocked: { code: "no-clone" } });
      continue;
    }
    // Mismo lookup cacheado (5 min) que usa la ficha para pintar sus MRs: ni una llamada extra a GitLab.
    const branch = (await sessionsIpc.linkDetail(link)).sourceBranch;
    const existing = branch ? (await local.listWorktrees(clone)).find((w) => w.branch === branch)?.dir : null;
    byProject.set(link.project, {
      project: link.project,
      base: existing || clone,
      clone,
      worktree: Boolean(existing && agentWorktree(existing)),
      branch,
      newWorktree: Boolean(branch && !existing),
      warnings: branch ? [] : [{ code: "mr-branch-unknown", iid: link.iid }],
    });
  }
  return [...byProject.values()];
}

// La sonda de salud reusa lo que ya hay configurado para Entornos (/health + "Healthy" en las tres APIs).
const probeConfig = () => ({ healthPaths: config.load().environments?.healthPaths || {}, healthExpect: config.load().environments?.healthExpect || {} });

const plan = async (s) => {
  const { hostsLine, items } = await localRun.buildPlan(await entriesFor(s), probeConfig());
  return { hostsLine, items };
};

function checkedProjects(projects) {
  if (!Array.isArray(projects) || !projects.length) throw new Error("Elige al menos un proyecto.");
  if (!projects.every((p) => typeof p === "string" && PROJECT_RE.test(p))) throw new Error("Proyecto no válido.");
  return new Set(projects);
}

// { [front]: { [api]: "local" | "dev" } } de la ficha: lo que no encaje se ignora (y se queda en Local).
function checkedTargets(targets) {
  const out = {};
  for (const [project, byKey] of Object.entries(targets && typeof targets === "object" ? targets : {})) {
    if (!PROJECT_RE.test(project) || !byKey || typeof byKey !== "object") continue;
    out[project] = Object.fromEntries(Object.entries(byKey).filter(([key, value]) => /^[a-z]+$/.test(key) && (value === "local" || value === "dev")));
  }
  return out;
}

// El renderer solo manda paths de proyecto: la sesión, las carpetas y los comandos se resuelven otra vez aquí.
async function start(s, projects, targets) {
  const wanted = checkedProjects(projects);
  const chosen = checkedTargets(targets);
  const entries = (await entriesFor(s)).filter((e) => wanted.has(e.project));
  const skipped = [];
  for (const project of wanted) {
    if (!entries.some((e) => e.project === project)) skipped.push({ project, reason: { code: "not-in-session" } });
  }
  // Los worktrees se crean ANTES de planificar: así el preflight (.env, node_modules) mira la carpeta real.
  for (const entry of entries) {
    if (!entry.newWorktree) continue;
    try {
      entry.base = await local.branchWorktree(entry.clone, entry.branch);
      entry.worktree = agentWorktree(entry.base);
      entry.newWorktree = false;
    } catch (err) {
      entry.base = entry.clone;
      entry.newWorktree = false;
      entry.warnings = [...(entry.warnings || []), { code: "worktree-failed", branch: entry.branch, error: err.message }];
    }
  }
  // Antes de planificar: el .env (y los certs del launcher) del clon al worktree, que git no los lleva.
  // Así el preflight ya los ve y no bloquea por algo que Monstro puede resolver solo.
  for (const entry of entries) localRun.copyLocalFiles(entry);
  const { items, plans } = await localRun.buildPlan(entries, { ...probeConfig(), targets: chosen });
  const started = [];
  // En orden: primero las APIs (los fronts necesitan sus puertos), que es como salen del plan.
  for (const item of items) {
    const step = plans.get(item.project);
    if (item.blocked || !step) {
      skipped.push({ project: item.project, reason: item.blocked || { code: "no-plan" } });
      continue;
    }
    if (!fs.existsSync(item.dir)) {
      skipped.push({ project: item.project, reason: { code: "dir-gone", dir: item.dir } });
      continue;
    }
    // El comando ya lleva las variables: el fichero es para lo que arranque el agente después.
    try { localRun.persistOverrides(step); } catch (err) { console.error("[localRun] override", err); }
    try {
      await sessionsIpc.openInGhostty(item.dir, step.command);
      localRun.remember(item.project, { url: item.url, openUrl: item.openUrl, dir: item.dir, port: item.port, kind: item.kind, probeUrl: step.probeUrl, expect: step.expect });
      started.push({ project: item.project, url: item.url });
    } catch (err) {
      skipped.push({ project: item.project, reason: { code: "launch-failed", error: err.message } });
    }
  }
  return { started, skipped };
}

function register() {
  ipcMain.handle("localRun:plan", async (_event, { sessionId } = {}) => plan(sessionsIpc.sessionOf(sessionId)));
  ipcMain.handle("localRun:start", async (_event, { sessionId, projects, targets } = {}) => start(sessionsIpc.sessionOf(sessionId), projects, targets));
  ipcMain.handle("localRun:status", () => localRun.status());
}

module.exports = { register };
