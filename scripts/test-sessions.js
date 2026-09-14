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
const { parseLink, scanTranscript, hostFromChain, lastTurn, sessionActivity, shellQuote, claudeCommand, launchSlug } = require("../src/sessions");
const detail = require("../src/sessions-detail");

// claudeCommand: la línea que Monstro TECLEA en tu shell (pestaña de Ghostty). Nada del prompt puede
// cerrar las comillas y ejecutar otra cosa.
assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
assert.strictEqual(
  claudeCommand({ name: "Review !789", prompt: "/mr-review-gitlab https://g/x/-/merge_requests/789" }),
  "claude -n 'Review !789' '/mr-review-gitlab https://g/x/-/merge_requests/789'",
);
assert.strictEqual(claudeCommand({ name: "n", worktree: "w-1", prompt: "a'; rm -rf ~ #" }), "claude -w 'w-1' -n 'n' 'a'\\''; rm -rf ~ #'");
assert.match(launchSlug("Añadir el login con 2FA ya mismo"), /^anadir-el-login-con-[a-z0-9]{5}$/);

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
  assert.deepStrictEqual(lastTurn(acc), { ended: false, asks: false, excerpt: null, questionText: null, activity: "Edit · app/sessions.js", choice: null });

  // Cierra el turno preguntando → te espera; el extracto es la pregunta, sin markdown.
  fs.appendFileSync(file, line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } })
    + line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Hecho el cambio.\n\n¿Hago **commit** de `sessions.js`?" }] } }));
  acc = await scanTranscript(file);
  assert.deepStrictEqual(lastTurn(acc), { ended: true, asks: true, excerpt: "¿Hago commit de sessions.js?", questionText: "¿Hago commit de sessions.js?", activity: null, choice: null });
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

  // Ficha: tus peticiones (sin lo que meten el CLI / el IDE), ficheros con el diff APLICADO, recap, tiempo y coste.
  const sheet = path.join(path.dirname(file), "ficha.jsonl");
  const result = (id, toolUseResult) => line({ type: "user", toolUseResult, message: { content: [{ tool_use_id: id, type: "tool_result" }] } });
  fs.writeFileSync(
    sheet,
    line({ type: "user", timestamp: "2026-09-10T09:12:00.000Z", message: { content: [{ type: "text", text: "<ide_opened_file>abrió x.js</ide_opened_file>" }, { type: "text", text: "añade   la ficha" }] } })
    + line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>ruido</local-command-caveat>" } })
    + line({ type: "user", message: { content: "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>!789</command-args>" } })
    + line({ type: "user", message: { content: "<local-command-stdout>salida</local-command-stdout>" } })
    + line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    + result("t1", { filePath: "/r/web/a.js", structuredPatch: [{ lines: [" ctx", "-viejo", "+nuevo", "+otra"] }] })
    + result("t2", { filePath: "/r/web/a.js", structuredPatch: [{ lines: ["-x"] }] })
    + result("t3", { type: "create", filePath: "/r/web/b.js", content: "1\n2\n3\n", structuredPatch: [] })
    + result("t4", "Error: String to replace not found") // un Edit que falla no deja diff: no cuenta
    + line({ type: "system", subtype: "away_summary", content: "Añadiste la ficha; falta el test.", timestamp: "2026-09-10T10:00:00.000Z" })
    + line({ type: "system", subtype: "turn_duration", durationMs: 60000 })
    + line({ type: "system", subtype: "turn_duration", durationMs: 30000 })
    + line({ type: "cost-state", totalCostUSD: 3.5 }),
  );
  const sheetAcc = await scanTranscript(sheet);
  assert.deepStrictEqual(sheetAcc.prompts, [{ at: Date.parse("2026-09-10T09:12:00.000Z"), text: "añade la ficha" }, { at: null, text: "/review !789" }]);
  assert.deepStrictEqual(Object.fromEntries(sheetAcc.files), { "/r/web/a.js": { added: 2, removed: 2 }, "/r/web/b.js": { added: 3, removed: 0 } });
  assert.deepStrictEqual(sheetAcc.awaySummary, { text: "Añadiste la ficha; falta el test.", at: Date.parse("2026-09-10T10:00:00.000Z") });
  assert.strictEqual(sheetAcc.workMs, 90000);
  assert.strictEqual(sheetAcc.costUSD, 3.5);

  // Lanzada desde Agents, la review va por slash command (sin llamada a la tool Skill): también cuenta.
  // Que la mencione un tool_result (p.ej. un Read del propio código de Monstro) no.
  const slash = "<command-message>mr-review-gitlab</command-message>\n<command-name>/mr-review-gitlab</command-name>\n<command-args>https://g/x/-/merge_requests/789</command-args>";
  const launchedFile = path.join(path.dirname(file), "lanzada.jsonl");
  fs.writeFileSync(launchedFile, result("t9", slash));
  assert.strictEqual((await scanTranscript(launchedFile)).review, false);
  fs.appendFileSync(launchedFile, line({ type: "user", message: { content: slash } }));
  assert.strictEqual((await scanTranscript(launchedFile)).review, true);

  // Pregunta con opciones (AskUserQuestion sin contestar): te espera ya, sin status (VS Code) o aunque diga busy.
  const askFile = path.join(path.dirname(file), "pregunta.jsonl");
  const question = { question: "¿Qué alcance?", header: "Alcance", multiSelect: false, options: [{ label: "Solo el parche", description: "d".repeat(400), preview: "<div>maqueta</div>" }, { label: "Todo" }] };
  fs.writeFileSync(
    askFile,
    line({ type: "user", message: { content: "arregla el sidebar" } })
    + line({ type: "assistant", message: { id: "m1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions: [question] } }] } })
    + line({ type: "attachment", attachment: {} }),
  );
  let askAcc = await scanTranscript(askFile);
  let activity = sessionActivity({}, askAcc);
  assert.strictEqual(activity.state, "waiting");
  assert.strictEqual(sessionActivity({ status: "busy" }, askAcc).state, "waiting");
  assert.strictEqual(activity.question.kind, "choice");
  const [item] = activity.question.items;
  assert.deepStrictEqual({ ...item, options: item.options.map((o) => o.label) }, { header: "Alcance", question: "¿Qué alcance?", multiSelect: false, options: ["Solo el parche", "Todo"] });
  assert.strictEqual(item.options[0].description.length, 300); // recortada, y sin preview
  assert.ok(!("preview" in item.options[0]));
  assert.strictEqual(item.options[1].description, "");
  assert.strictEqual(sessionActivity(null, askAcc).question, null); // terminada: ya nadie puede contestarla

  // Contestada (llega su tool_result) → sin pregunta.
  fs.appendFileSync(askFile, line({ type: "user", toolUseResult: { answers: { "¿Qué alcance?": "Todo" } }, message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: "Your questions have been answered" }] } }));
  askAcc = await scanTranscript(askFile);
  assert.strictEqual(sessionActivity({ status: "busy" }, askAcc).question, null);

  // Pregunta abierta en texto: el párrafo entero y sin markdown (el extracto del card se queda en 240).
  const longQuestion = `¿${"Lo dejo con la caché en memoria o prefieres Redis ".repeat(6).trim()}?`;
  fs.appendFileSync(askFile, line({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: `Hecho el parche.\n\n**${longQuestion}**` }] } }));
  askAcc = await scanTranscript(askFile);
  activity = sessionActivity({ status: "idle" }, askAcc);
  assert.strictEqual(activity.state, "waiting");
  assert.deepStrictEqual(activity.question, { kind: "open", text: longQuestion });
  assert.strictEqual(activity.excerpt.length, 240);
  // Un permiso pendiente no es una pregunta que contestar.
  assert.strictEqual(sessionActivity({ status: "waiting", waitingFor: "permission" }, askAcc).question, null);
  assert.strictEqual(sessionActivity({ status: "busy" }, askAcc).question, null);

  // Plan: solo la llamada real a ExitPlanMode marca la sesión; citarla en un texto (va escapada) no.
  fs.appendFileSync(askFile, line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: '{"name":"ExitPlanMode","input":{"plan":"x"}}' }] } }));
  assert.strictEqual((await scanTranscript(askFile)).hasPlan, false);
  fs.appendFileSync(askFile, line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_plan", name: "ExitPlanMode", input: { plan: "# Plan\n\n1. Hacerlo" } }] } }));
  assert.strictEqual((await scanTranscript(askFile)).hasPlan, true);

  // Ficha bajo demanda (src/sessions-detail.js): último plan, último mensaje de Claude, commits (salida normal,
  // -q + git log, amend) y el diff aplicado con tope de líneas.
  const detailFile = path.join(path.dirname(file), "detalle.jsonl");
  const bash = (id, command) => line({ type: "assistant", cwd: "/r/api", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const bashOut = (id, stdout, isError = false) => line({
    type: "user", cwd: "/r/api", toolUseResult: isError ? stdout : { stdout, stderr: "", interrupted: false },
    message: { content: [{ type: "tool_result", tool_use_id: id, content: stdout, is_error: isError }] },
  });
  const big = Array.from({ length: 350 }, (_, i) => `l${i}`).join("\n");
  fs.writeFileSync(
    detailFile,
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "# Plan A" } }] } })
    + line({ type: "assistant", message: { content: [{ type: "tool_use", id: "p2", name: "ExitPlanMode", input: { plan: "# Plan B" } }] } })
    + bash("toolu_c1", "git add -A && git commit -m 'feat: uno'") + bashOut("toolu_c1", "[feat/x 1a2b3c4] feat: uno\n 1 file changed, 2 insertions(+)")
    + bash("toolu_c2", "git commit -q -m dos && git commit -q -m tres && git log --oneline -3") + bashOut("toolu_c2", "ccccccc tres\nbbbbbbb dos\n1a2b3c4 feat: uno")
    + bash("toolu_c3", "git commit -q -m cuatro && echo ok") + bashOut("toolu_c3", "ok") // -q sin git log: no hay hash
    + bash("toolu_c4", "git commit -m nada") + bashOut("toolu_c4", "Error: Exit code 1\nnothing to commit, working tree clean", true)
    + bash("toolu_c5", "git commit -q --amend -m 'tres bis' && git log -1 --format='%h %s'") + bashOut("toolu_c5", "ddddddd tres bis")
    + result("e1", { filePath: "/r/api/a.js", structuredPatch: [{ oldStart: 3, newStart: 3, lines: [" ctx", "-viejo", "+nuevo"] }] })
    + result("e2", { type: "create", filePath: "/r/api/big.txt", content: `${big}\n`, structuredPatch: [] })
    + result("e3", { filePath: "/r/api/a.js", structuredPatch: [{ oldStart: 10, newStart: 10, lines: ["+otra"] }] })
    + line({ type: "assistant", message: { id: "f1", content: [{ type: "text", text: "Primero." }] } })
    + line({ type: "assistant", message: { id: "f1", content: [{ type: "text", text: "Segundo." }] } })
    + line({ type: "assistant", message: { id: "f1", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/r/api/a.js" } }] } })
    + line({ type: "assistant", message: { id: "s1", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } }),
  );
  const sheetDetail = await detail.read(detailFile);
  assert.strictEqual(sheetDetail.plan, "# Plan B");
  assert.strictEqual(sheetDetail.finalMessage, "Primero.\n\nSegundo.");
  assert.deepStrictEqual(sheetDetail.commits, [
    { repo: null, hash: "1a2b3c4", subject: "feat: uno" },
    { repo: null, hash: "bbbbbbb", subject: "dos" },
    { repo: null, hash: "ddddddd", subject: "tres bis" }, // el amend sustituye a "tres"
  ]);
  assert.deepStrictEqual(
    sheetDetail.changes.map((c) => [c.rel, c.added, c.removed, c.hunks.length, Boolean(c.truncated)]),
    [["/r/api/a.js", 2, 1, 2, false], ["/r/api/big.txt", 350, 0, 1, true]],
  );
  assert.deepStrictEqual(sheetDetail.changes[0].hunks[0], { oldStart: 3, newStart: 3, lines: [" ctx", "-viejo", "+nuevo"] });
  assert.strictEqual(sheetDetail.changes[1].hunks[0].lines.length, 300);
  assert.strictEqual(sheetDetail.changes[1].hunks[0].lines[0], "+l0");
  // El commit va al repo donde se hizo: `cd <dir> &&` al principio o `git -C <dir>`; si no, el cwd.
  assert.strictEqual(detail.commitDir("cd ~/repos/b && git commit -q", "/r/api"), path.join(os.homedir(), "repos/b"));
  assert.strictEqual(detail.commitDir("git -C ../web commit -m x", "/r/api"), "/r/web");
  assert.strictEqual(detail.commitDir("git commit -m x", "/r/api"), "/r/api");

  console.log("✓ sessions ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
