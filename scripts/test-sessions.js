#!/usr/bin/env node
"use strict";

/**
 * Check de src/sessions.js. El parseo del transcript es heurístico; lo que importa es que clasifique
 * bien los links (MR / issue / epic / PR), no se trague cwds de JSON incrustado y que el append se
 * lea incrementalmente sin duplicar contadores.
 * `node scripts/test-sessions.js`
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseLink, scanTranscript, hostFromChain, lastTurn, sessionActivity } = require("../src/sessions");

// hostFromChain: primer ancestro conocido; la extensión de VS Code NO es su terminal integrado.
assert.strictEqual(hostFromChain(["zsh", "login", "ghostty"]), "ghostty");
assert.strictEqual(hostFromChain(["zsh", "rider"]), "rider");
assert.strictEqual(hostFromChain(["Code Helper (Plugin)", "Code"]), "vscode-ext");
assert.strictEqual(hostFromChain(["zsh", "Code Helper", "Code"]), "vscode");
assert.strictEqual(hostFromChain(["zsh", "launchd"]), null);

const GL = "https://gitlab.example.com";
const MR_KEY = "mr:gitlab.example.com/Grupo/api#789";

// parseLink: URL canónica (sin /diffs), epic = issue del proyecto …/epics, work_items = issue, GitHub PR.
assert.deepStrictEqual(parseLink(`${GL}/Grupo/api/-/merge_requests/789/diffs`), {
  key: MR_KEY, kind: "mr", host: "gitlab.example.com", project: "Grupo/api", iid: 789, url: `${GL}/Grupo/api/-/merge_requests/789`,
});
assert.strictEqual(parseLink(`${GL}/Grupo/epics/-/issues/45`).kind, "epic");
assert.strictEqual(parseLink(`${GL}/Grupo/sub/api/-/work_items/12`).kind, "issue");
assert.strictEqual(parseLink("https://github.com/o/r/pull/19").kind, "pr");
assert.strictEqual(parseLink("http://inseguro.example/g/p/-/issues/1"), null);
assert.strictEqual(parseLink("hola"), null);

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "monstro-sessions-")), "s.jsonl");
const line = (entry) => `${JSON.stringify(entry)}\n`;
fs.writeFileSync(
  file,
  line({ type: "user", entrypoint: "sdk-cli", cwd: "/r/api", gitBranch: "feat/x", timestamp: "2026-09-10T07:11:50.917Z", message: { content: `revisa ${GL}/Grupo/api/-/merge_requests/789` } })
  + line({ type: "last-prompt", lastPrompt: "revisa la MR" })
  + line({ type: "ai-title", aiTitle: "MR 789 revisión" })
  // El JSON de otra sesión dentro de un tool_result va escapado: su cwd NO cuenta. El file_path de una tool call sí.
  + line({ type: "user", cwd: "/r/api/.worktrees/mr", gitBranch: "fix/y", toolUseResult: "{\"cwd\":\"/otra/sesion\"}", message: { content: [{ type: "tool_use", input: { file_path: "/r/web/src/a.ts" } }] } })
  // Hablar de la skill en un texto (escapado) no convierte la sesión en una de review.
  + line({ type: "user", toolUseResult: "{\"skill\":\"mr-review-gitlab\"}" })
  + '{"type":"user","cwd":"/r/b', // línea a medio escribir: se ignora hasta que llegue su \n
);

(async () => {
  let acc = await scanTranscript(file);
  assert.strictEqual(acc.entrypoint, "sdk-cli");
  assert.strictEqual(acc.lastAt, Date.parse("2026-09-10T07:11:50.917Z")); // actividad = timestamp, no mtime
  assert.strictEqual(acc.aiTitle, "MR 789 revisión");
  assert.strictEqual(acc.lastPrompt, "revisa la MR");
  assert.strictEqual(acc.branches.get("/r/api"), "feat/x");
  assert.strictEqual(acc.branches.get("/r/api/.worktrees/mr"), "fix/y");
  assert.ok(!acc.dirs.has("/otra/sesion"));
  assert.ok(acc.dirs.has("/r/web/src"));
  assert.ok(!acc.dirs.has("/r/b"));
  assert.strictEqual(acc.links.get(MR_KEY).count, 1);

  // Append: se completa la línea partida y llega otra mención → solo se lee lo nuevo.
  fs.appendFileSync(file, `ff"}\n${line({ type: "user", message: { content: `${GL}/Grupo/api/-/merge_requests/789 y ${GL}/Grupo/epics/-/issues/45` } })}`);
  acc = await scanTranscript(file);
  assert.ok(acc.dirs.has("/r/bff"));
  assert.strictEqual(acc.links.get(MR_KEY).count, 2);
  assert.strictEqual(acc.links.get("epic:gitlab.example.com/Grupo/epics#45").kind, "epic");

  // La llamada real a la skill de review sí la marca.
  assert.strictEqual(acc.review, false);
  fs.appendFileSync(file, line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Skill", input: { skill: "mr-review-gitlab" } }] } }));
  acc = await scanTranscript(file);
  assert.strictEqual(acc.review, true);

  // Turno: Claude lanza una herramienta → sigue siendo su turno, con la actividad resumida.
  fs.appendFileSync(file, line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/r/web/app/sessions.js" } }] } }));
  acc = await scanTranscript(file);
  assert.deepStrictEqual(lastTurn(acc), { ended: false, asks: false, excerpt: null, activity: "Edit · app/sessions.js" });

  // Cierra el turno preguntando → te espera; el extracto es la pregunta, sin markdown.
  fs.appendFileSync(file, line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } })
    + line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Hecho el cambio.\n\n¿Hago **commit** de `sessions.js`?" }] } }));
  acc = await scanTranscript(file);
  assert.deepStrictEqual(lastTurn(acc), { ended: true, asks: true, excerpt: "¿Hago commit de sessions.js?", activity: null });
  assert.strictEqual(sessionActivity({ status: "idle" }, acc).state, "waiting");
  assert.strictEqual(sessionActivity({}, acc).state, "waiting"); // sin status (VS Code): se deduce igual

  // Cierra el turno con un informe, sin preguntar → abierta pero terminada. Una `?.` de código no es pregunta.
  fs.appendFileSync(file, line({ type: "user", message: { content: "vale" } })
    + line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Listo: `s?.host` ya no rompe.\n\nTests en verde." }] } }));
  acc = await scanTranscript(file);
  assert.strictEqual(lastTurn(acc).asks, false);
  assert.strictEqual(sessionActivity({ status: "idle" }, acc).state, "done");
  assert.strictEqual(sessionActivity({ status: "waiting", waitingFor: "permission" }, acc).state, "waiting");
  assert.strictEqual(sessionActivity({ status: "busy" }, acc).state, "working");
  assert.strictEqual(sessionActivity(null, acc).state, "finished");

  // Pregunta retórica que se responde sola → no te espera: la pregunta tiene que cerrar el párrafo.
  fs.appendFileSync(file, line({ type: "user", message: { content: "¿y el mtime?" } })
    + line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "¿Y sabes por qué? Porque el mtime miente.\n\nArreglado, te lo digo yo." }] } }));
  acc = await scanTranscript(file);
  assert.strictEqual(sessionActivity({ status: "idle" }, acc).state, "done");

  // Nuevo prompt tuyo después → vuelve a ser turno de Claude.
  fs.appendFileSync(file, line({ type: "user", message: { content: "venga, dale" } }));
  acc = await scanTranscript(file);
  assert.strictEqual(lastTurn(acc).ended, false);

  console.log("✓ sessions ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
