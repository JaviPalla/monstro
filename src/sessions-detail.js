"use strict";

/**
 * Ficha de una sesión de Claude Code BAJO DEMANDA (sessions:detail; no va en el poll de sessions:list): el
 * último plan, el último mensaje de Claude, sus commits y el diff de lo que editó. Relee el transcript entero,
 * pero solo parsea las líneas que pueden traer algo (mismo truco de substrings que src/sessions.js: dentro de
 * un tool_result esas claves van escapadas y no casan).
 * Sin electron → scripts/test-sessions.js lo prueba con node.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { relOf, repoOf, clipText } = require("./sessions");

const FINAL_MAX = 6000;
const FILE_LINES_MAX = 300;
const TOTAL_LINES_MAX = 4000;
const LINE_MAX = 1000; // el Write de un fichero minificado es UNA línea de megas
// Llamada a `git commit` en el command de un Bash (también `git -C dir commit` y `git -c k=v commit`).
const COMMIT_CMD_RE = /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/;
// Salida normal: "[rama 1a2b3c4] asunto" (y "[rama (root-commit) …]", "[detached HEAD …]").
const COMMIT_OUT_RE = /^\[[^\]\n]+ ([0-9a-f]{7,40})\] (.+)$/gm;
// Con `git commit -q` (lo habitual en Claude: 106 de 129 en transcripts reales) solo lo cuenta el
// `git log --oneline` que va detrás: "1a2b3c4 asunto".
const ONELINE_RE = /^([0-9a-f]{7,40}) (.+)$/gm;
const LOG_CMD_RE = /\bgit\s+(?:--no-pager\s+)?(?:log|show)\b/;
// ponytail: una entrada por transcript abierto en la ficha, sin purgar; se va con el proceso.
const cache = new Map(); // transcript → { size, mtimeMs, detail }

// Dónde se hizo el commit: `git -C <dir>` o un `cd <dir>` al principio del comando (Claude commitea así en
// otro repo sin moverse de su cwd); si no, el cwd de la línea.
function commitDir(command, cwd) {
  const m = /\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command) || /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
  if (!m) return cwd || null;
  const dir = m[1].replace(/^(["'])(.*)\1$/, "$2").replace(/^~(?=\/|$)/, os.homedir());
  return path.resolve(cwd || os.homedir(), dir);
}

// Commits que dejó un comando con `git commit`, sacados de su salida. Con -q no imprime nada: valen las
// primeras N líneas "hash asunto" de un git log del mismo comando (N = commits del comando; las siguientes
// de un `git log -3` ya estaban), que salen de la más nueva a la más vieja.
function commitsFrom(command, out, ok) {
  const found = [...out.matchAll(COMMIT_OUT_RE)].map((m) => ({ hash: m[1], subject: m[2].trim() }));
  if (found.length || !ok || !LOG_CMD_RE.test(command)) return found;
  const n = (command.match(new RegExp(COMMIT_CMD_RE.source, "g")) || []).length;
  return [...out.matchAll(ONELINE_RE)].slice(0, n).reverse().map((m) => ({ hash: m[1], subject: m[2].trim() }));
}

function addCommits(commits, pending, line) {
  const id = [...pending.keys()].find((k) => line.includes(k));
  if (!id) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const block = (Array.isArray(entry.message?.content) ? entry.message.content : []).find((b) => b.type === "tool_result" && b.tool_use_id === id);
  if (!block) return;
  const { command, cwd } = pending.get(id);
  pending.delete(id);
  const result = entry.toolUseResult;
  // Un comando que falla deja un string "Error: …"; si el commit entró antes (p.ej. falló el push) sigue ahí.
  const ok = !block.is_error && result !== null && typeof result === "object";
  const out = ok ? String(result.stdout || "") : typeof result === "string" ? result : typeof block.content === "string" ? block.content : "";
  const found = commitsFrom(command, out, ok);
  if (!found.length) return;
  const dir = commitDir(command, cwd || entry.cwd);
  // --amend reescribe el último commit de ese repo: se sustituye, no se suma.
  if (/--amend\b/.test(command)) {
    const i = commits.findLastIndex((c) => c.dir === dir);
    if (i >= 0) commits.splice(i, 1);
  }
  for (const c of found) {
    if (!commits.some((x) => x.dir === dir && x.hash === c.hash)) commits.push({ dir, ...c });
  }
}

// Diff APLICADO de un Edit/Write (toolUseResult.structuredPatch; un Edit que falla no lo trae). Un Write que
// crea el fichero viene sin hunks: su contenido entero son líneas "+".
function hunksOf(result) {
  const hunks = (Array.isArray(result.structuredPatch) ? result.structuredPatch : [])
    .map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: Array.isArray(h.lines) ? h.lines : [] }));
  if (!hunks.length && result.type === "create" && typeof result.content === "string" && result.content) {
    hunks.push({ oldStart: 0, newStart: 1, lines: result.content.replace(/\n$/, "").split("\n").map((l) => `+${l}`) });
  }
  return hunks;
}

function addChange(files, line) {
  let result;
  try { result = JSON.parse(line).toolUseResult; } catch { return; }
  if (typeof result?.filePath !== "string") return;
  const hunks = hunksOf(result);
  const f = files.get(result.filePath) || { added: 0, removed: 0, hunks: [] };
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l[0] === "+") f.added++;
      else if (l[0] === "-") f.removed++;
    }
  }
  f.hunks.push(...hunks);
  files.set(result.filePath, f); // un Map conserva el orden: el del primer cambio de cada fichero
}

// Una pasada por el transcript. El último mensaje de Claude = los bloques de texto del último mensaje que
// tiene texto (el CLI escribe cada bloque en su línea, todas con el mismo message.id).
function parse(text) {
  const out = { plan: null, final: null, commits: [], files: new Map() };
  const pending = new Map(); // id de una llamada a Bash con git commit → { command, cwd }
  let msgId = null;
  let msgTexts = [];
  for (const line of text.split("\n")) {
    if (line.includes('"type":"assistant"')) {
      const wantsPlan = line.includes('"name":"ExitPlanMode"');
      const wantsCommit = line.includes('"name":"Bash"') && line.includes("commit");
      // <synthetic> = mensajes que inventa el CLI ("No response requested.", errores de API): no son de Claude.
      const wantsText = line.includes('"type":"text"') && !line.includes('"model":"<synthetic>"');
      if (!wantsPlan && !wantsCommit && !wantsText) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "assistant") continue;
      const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        if (b.name === "ExitPlanMode" && typeof b.input?.plan === "string") out.plan = b.input.plan;
        else if (b.name === "Bash" && COMMIT_CMD_RE.test(b.input?.command || "")) pending.set(b.id, { command: b.input.command, cwd: entry.cwd || null });
      }
      const texts = wantsText ? blocks.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text.trim()) : [];
      if (!texts.length) continue;
      const id = entry.message?.id || null;
      if (!id || id !== msgId) msgTexts = [];
      msgId = id;
      msgTexts.push(...texts);
      out.final = msgTexts.join("\n\n");
    } else if (line.includes('"type":"user"')) {
      if (line.includes('"structuredPatch":')) addChange(out.files, line);
      else if (pending.size && line.includes('"tool_use_id"')) addCommits(out.commits, pending, line);
    }
  }
  return out;
}

// Ficheros → { repo, rel, added, removed, hunks } con tope de líneas por fichero y en total; el que se
// corta lleva truncated: true (los +/− cuentan siempre el cambio entero).
async function changesOf(files) {
  let budget = TOTAL_LINES_MAX;
  const out = [];
  for (const [file, f] of files) {
    const where = await relOf(file);
    // Los planes que escribe Claude (~/.claude/plans) tienen su pestaña: no son cambios del proyecto.
    if (!where.repo && where.rel.startsWith("~/.claude/plans/")) continue;
    const cap = Math.min(FILE_LINES_MAX, budget);
    const hunks = [];
    let used = 0;
    let truncated = false;
    for (const h of f.hunks) {
      if (used >= cap) {
        truncated = true;
        break;
      }
      const lines = h.lines.slice(0, cap - used).map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l));
      if (lines.length < h.lines.length) truncated = true;
      hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
      used += lines.length;
    }
    budget -= used;
    out.push({ ...where, added: f.added, removed: f.removed, hunks, ...(truncated ? { truncated: true } : {}) });
  }
  return out;
}

/** { plan, finalMessage, commits: [{repo, hash, subject}], changes } de un transcript (cacheado mientras no crezca). */
async function read(file) {
  const { size, mtimeMs } = await fs.promises.stat(file);
  const hit = cache.get(file);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.detail;
  const parsed = parse(await fs.promises.readFile(file, "utf8"));
  const commits = [];
  for (const c of parsed.commits) commits.push({ repo: c.dir ? (await repoOf(c.dir))?.name || null : null, hash: c.hash, subject: c.subject });
  const detail = { plan: parsed.plan, finalMessage: clipText(parsed.final, FINAL_MAX), commits, changes: await changesOf(parsed.files) };
  cache.set(file, { size, mtimeMs, detail });
  return detail;
}

module.exports = { read, commitDir };
