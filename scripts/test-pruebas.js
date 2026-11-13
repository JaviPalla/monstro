#!/usr/bin/env node
"use strict";

// Reglas de la sección Pruebas (src/pruebas-rules.js): qué tareas hay, botón de cada job, estado de la
// cabecera y validación de lo que llega del renderer. Casos sacados de tareas y pipelines reales de
// OpenSaludGroup (12-nov-2026). `node scripts/test-pruebas.js`

const assert = require("assert");
const R = require("../src/pruebas-rules");

const E = R.EPIC_JOBS;
const M = R.MR_JOBS;
const job = (name, status, extra = {}) => ({ id: 1, name, stage: "s", status, projectId: 12, ...extra });

// ---- citas de epic, número de issue y hotfix
assert.deepStrictEqual(R.epicRefs("Parte de OpenSaludGroup/epics#343 y epics#12"), [12, 343]);
assert.deepStrictEqual(R.epicRefs("https://gitlab.openhealth.es/OpenSaludGroup/epics/-/issues/303"), [303]);
assert.deepStrictEqual(R.epicRefs("sin cita, ver #343 y xepics#9 y otro-epics#5"), [], "ni #N suelto ni prefijos pegados");
assert.strictEqual(R.mrIssueNumber({ description: "Closes #459\nmás", branch: "features/100-x" }), 459, "la descripción manda");
assert.strictEqual(R.mrIssueNumber({ description: "sin ref", branch: "hotfix/461-registration-signup-errors" }), 461, "la rama es pista");
assert.strictEqual(R.mrIssueNumber({ description: "", branch: "fix/network-error" }), null);
assert.ok(R.isHotfix({ branch: "hotfix/496-two-hours", labels: [] }));
assert.ok(R.isHotfix({ branch: "features/1-x", labels: ["sin-dev"] }));
assert.ok(!R.isHotfix({ branch: "features/1-x", labels: ["pending check"] }));
assert.strictEqual(R.cycleLabel(["bug", "checking"]), "checking");
assert.strictEqual(R.cycleLabel(["bug"]), null);

// ---- buildTasks: epics #369 y #303, issues locales, hotfix y MR suelta (datos del 12-nov)
const mr = (projectId, iid, over = {}) => ({ projectId, iid, repo: `p${projectId}`, title: `mr ${iid}`, description: "", branch: `features/${iid}-x`, labels: [], draft: false, url: `https://g/${projectId}/${iid}`, ...over });
const epic = (iid, labels = ["pending check"]) => ({ iid, projectId: 62, repo: "epics", title: `epic ${iid}`, url: `https://g/epics/${iid}`, labels, isEpic: true });
const local = (projectId, iid) => ({ iid, projectId, repo: `p${projectId}`, title: `issue ${iid}`, url: `https://g/i/${projectId}/${iid}`, labels: ["pending check"], isEpic: false });
{
  const mrs = [
    mr(11, 923, { description: "Parte de epics#369" }),
    mr(19, 230, { description: "https://gitlab.openhealth.es/OpenSaludGroup/epics/-/issues/369\nCloses #134" }),
    mr(12, 787, { description: "Refs OpenSaludGroup/epics#369" }),
    mr(12, 999, { description: "ver epics#400" }), // la epic 369 la lista como relacionada, pero solo cita otra
    mr(11, 1044, { title: "fix epics#303" }),
    mr(11, 1100, { description: "Closes #459" }),
    mr(11, 1008, { branch: "hotfix/461-registration-signup-errors" }),
    mr(12, 950, { branch: "hotfix/496-two-hours-icon-unconfirmed" }),
    mr(12, 1200, { labels: ["pending check", "QA: alejandro"] }),
    mr(12, 1300, { branch: "hotfix/484-otro" }), // hotfix de una issue que ya tiene tarjeta
  ];
  const related = {
    369: [{ projectId: 11, iid: 923 }, { projectId: 19, iid: 230 }, { projectId: 12, iid: 787 }, { projectId: 12, iid: 999 }],
    303: [{ projectId: 11, iid: 1044 }],
    400: [],
  };
  const issues = [epic(303, ["pending check", "QA: alejandro.perez", "enhancement"]), epic(369), epic(400), local(11, 459), local(19, 134), local(25, 7), local(12, 484)];
  const tasks = R.buildTasks({ issues, mrs, related });
  assert.deepStrictEqual(
    tasks.map((t) => t.key),
    ["epic:62#400", "epic:62#369", "epic:62#303", "issue:11#459", "issue:25#7", "issue:12#484", "mr:11!1008", "mr:12!950", "mr:12!1200"],
    "epics (la más nueva primero), issues, y MRs sueltas; la issue 19#134 la representa su epic",
  );
  const by = (key) => tasks.find((t) => t.key === key);
  assert.deepStrictEqual(by("epic:62#369").mrs.map((m) => `${m.projectId}!${m.iid}`), ["11!923", "19!230", "12!787"], "12!999 solo cita otra epic");
  assert.deepStrictEqual(by("epic:62#400").mrs, [], "epic sin MRs sigue teniendo tarjeta");
  assert.deepStrictEqual(by("issue:11#459").mrs.map((m) => m.iid), [1100]);
  assert.deepStrictEqual(by("issue:12#484").mrs.map((m) => m.iid), [1300], "el hotfix de una issue con tarjeta va en esa tarjeta");
  assert.ok(!tasks.some((t) => t.key === "mr:12!1300"), "y no se duplica como hotfix suelto");
  assert.ok(!tasks.some((t) => t.key === "issue:19#134"));
  assert.ok(by("mr:11!1008").hotfix && by("mr:12!950").hotfix && !by("mr:12!1200").hotfix);
  assert.strictEqual(by("mr:12!1200").label, "pending check");
  assert.strictEqual(by("epic:62#369").epicIid, 369);
  assert.strictEqual(by("issue:11#459").epicIid, null);
  assert.strictEqual(by("epic:62#369").ref, "#369");
  assert.strictEqual(by("issue:11#459").ref, "p11#459");
  assert.strictEqual(by("mr:12!950").ref, "p12!950");
  // todas las etiquetas de la issue/epic/MR (no solo la de ciclo): el filtro de la vista trabaja con ellas
  assert.deepStrictEqual(by("epic:62#303").labels, ["pending check", "QA: alejandro.perez", "enhancement"]);
  assert.deepStrictEqual(by("issue:11#459").labels, ["pending check"]);
  assert.deepStrictEqual(by("mr:12!1200").labels, ["pending check", "QA: alejandro"]);
  assert.deepStrictEqual(by("mr:12!950").labels, []);
}

// ---- traceReason: stderr de la traza real de probar-tarea (epic #303, pipeline #27555)
{
  const trace = [
    "2026-11-11T09:48:31.794399Z 01O $ git clone -q https://gitlab-ci-token:${CI_JOB_TOKEN}@host/OpenSaludGroup/delivery-flow.git /tmp/delivery-flow",
    "2026-11-11T09:48:32.383368Z 01O $ node /tmp/delivery-flow/scripts/epic-flow.cjs probar",
    "2026-11-11T09:48:35.919956Z 01E Dev no está libre en todos los proyectos, no se lanza nada:",
    "2026-11-11T09:48:35.919991Z 01E - openhealthcare-launcher: hay una MR activa pendiente de revisar en dev: !1043 (rama fix/x). Se libera cuando QA la valide.",
    "2026-11-11T09:48:36.322782Z 00O ERROR: Job failed: exit code 1",
  ].join("\n");
  assert.deepStrictEqual(R.traceReason(trace), [
    "Dev no está libre en todos los proyectos, no se lanza nada:",
    "- openhealthcare-launcher: hay una MR activa pendiente de revisar en dev: !1043 (rama fix/x). Se libera cuando QA la valide.",
  ]);
  assert.deepStrictEqual(R.traceReason("2026-11-11T09:00:00.1Z 01E \u001b[31;1mboom\u001b[0;m"), ["boom"], "sin códigos ANSI");
  assert.deepStrictEqual(R.traceReason("2026-11-11T09:00:00.1Z 00O solo stdout\n2026-11-11T09:00:01.1Z 00O+section_end:1:x"), [], "sin stderr no hay motivo");
  assert.deepStrictEqual(R.traceReason(""), []);
  assert.deepStrictEqual(R.traceReason(null), []);
  const many = Array.from({ length: 20 }, (_, i) => `2026-11-11T09:00:00.${i}Z 01E linea ${i}`).join("\n");
  assert.strictEqual(R.traceReason(many).length, 15);
  assert.strictEqual(R.traceReason(many)[14], "linea 19", "se queda con las últimas");
}

// ---- decorateJob: botón y confirmación
{
  assert.strictEqual(R.decorateJob(job(E.probar, "manual")).action, "play");
  assert.strictEqual(R.decorateJob(job(E.probar, "failed")).action, "retry");
  assert.strictEqual(R.decorateJob(job(E.probar, "canceled")).action, "retry");
  assert.strictEqual(R.decorateJob(job(E.probar, "success")).action, null);
  assert.strictEqual(R.decorateJob(job(E.probar, "running")).action, null);
  assert.strictEqual(R.decorateJob(job(E.mergear, "manual")).confirm, "merge");
  assert.strictEqual(R.decorateJob(job(E.devolver, "manual")).confirm, "return");
  assert.strictEqual(R.decorateJob(job(E.validar, "manual")).confirm, null);
  assert.strictEqual(R.decorateJob(job(M.validar, "manual"), { probarStatus: "manual" }).confirm, "no-dev", "validar sin haber pasado por dev");
  assert.strictEqual(R.decorateJob(job(M.validar, "manual"), { probarStatus: "success" }).confirm, null);
  assert.strictEqual(R.decorateJob(job(E.mergear, "success")).confirm, null, "sin botón no hay confirmación");
  assert.strictEqual(R.decorateJob(job(E.probar, "manual"), { pipelineStatus: "canceled" }).action, null, "pipeline cancelado: sin ▶");
  assert.strictEqual(R.decorateJob(job("sonarqube-check", "manual")).flow, false);
  assert.strictEqual(R.decorateJob(job(M.deploy, "success")).flow, true);
}

// ---- mrState con jobs reales
{
  // api!950 (hotfix): nada pulsado, desplegar saltado, validar manual.
  const hotfix = [job(M.probar, "manual"), job(M.deploy, "skipped"), job(M.validar, "manual"), job("test", "skipped"), job("sonarqube-check", "manual")];
  assert.strictEqual(R.mrState(hotfix), "probar-ready");
  // launcher!1043: desplegó y la validación falló.
  assert.strictEqual(R.mrState([job(M.probar, "success"), job(M.deploy, "success"), job(M.validar, "failed")]), "validate-failed");
  assert.strictEqual(R.mrState([job(M.probar, "success"), job(M.deploy, "success"), job(M.validar, "manual")]), "in-dev");
  assert.strictEqual(R.mrState([job(M.probar, "success"), job(M.deploy, "running"), job(M.validar, "created")]), "deploying");
  assert.strictEqual(R.mrState([job(M.probar, "success"), job(M.deploy, "created"), job(M.validar, "created")]), "deploying");
  assert.strictEqual(R.mrState([job(M.probar, "success"), job(M.deploy, "failed"), job(M.validar, "created")]), "deploy-failed");
  assert.strictEqual(R.mrState([job(M.probar, "success"), job(M.deploy, "success"), job(M.validar, "success")]), "merge-ready");
  assert.strictEqual(R.mrState([job(M.probar, "failed")]), "probar-failed");
  assert.strictEqual(R.mrState([]), "no-pipeline");
  assert.strictEqual(R.worstState(["merge-ready", "in-dev", "deploying"]), "deploying", "la tarea va con su MR más atrasada");
  assert.strictEqual(R.worstState([]), "no-mrs");
}

// ---- epicState con los pipelines reales de epics
{
  const manual = [job(E.mergear, "created"), job(E.devolver, "manual"), job(E.validar, "created"), job(E.probar, "manual")]; // #26977
  assert.strictEqual(R.epicState(manual, "manual"), "probar-ready");
  const failed = [job(E.mergear, "skipped"), job(E.devolver, "manual"), job(E.validar, "skipped"), job(E.probar, "failed")]; // #27555
  assert.strictEqual(R.epicState(failed, "failed"), "probar-failed");
  const validated = [job(E.mergear, "manual"), job(E.devolver, "success"), job(E.validar, "success"), job(E.probar, "success")]; // #26591
  assert.strictEqual(R.epicState(validated, "success"), "mergear-ready");
  assert.strictEqual(R.epicState([], null), "no-pipeline");
  assert.strictEqual(R.epicState(manual, "canceled"), "canceled", "ronda cancelada por el bot");
  const afterProbar = [job(E.probar, "success"), job(E.validar, "manual"), job(E.mergear, "created"), job(E.devolver, "manual")];
  assert.strictEqual(R.epicState(afterProbar, "manual", ["in-dev", "deploying"]), "probando", "validar manual pero aún desplegando");
  assert.strictEqual(R.epicState(afterProbar, "manual", ["in-dev", "in-dev"]), "validar-ready");
  assert.strictEqual(R.epicState(afterProbar, "manual", ["in-dev", "deploy-failed"]), "deploy-failed");
  assert.strictEqual(R.epicState([job(E.probar, "success"), job(E.validar, "failed")], "failed"), "validar-failed");
  assert.strictEqual(R.epicState([job(E.mergear, "success")], "success"), "merged");
  // validar-tarea es allow_failure: si falla, GitLab puede dejar mergear-tarea en manual y el pipeline en success.
  // La tarjeta no puede decir «Lista para mergear»: lo que pasó es que la validación falló.
  const validarFalla = [job(E.probar, "success"), job(E.validar, "failed"), job(E.devolver, "manual"), job(E.mergear, "manual")];
  assert.strictEqual(R.epicState(validarFalla, "success", ["in-dev"]), "validar-failed", "validar fallido gana a mergear manual");
  const mergeando = [job(E.probar, "success"), job(E.validar, "success"), job(E.devolver, "manual"), job(E.mergear, "running")];
  assert.strictEqual(R.epicState(mergeando, "running", ["merge-ready"]), "mergeando", "mergear-tarea en marcha no es «Subiendo a dev»");
  assert.strictEqual(R.epicState([job(E.probar, "success"), job(E.validar, "success"), job(E.mergear, "failed")], "failed"), "mergear-failed");
}

// ---- rondas de pipeline sin terminar (no se crea otra encima)
{
  for (const open of ["manual", "running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"]) assert.ok(R.isOpenPipeline(open), open);
  for (const done of ["success", "failed", "canceled", "skipped", undefined]) assert.ok(!R.isOpenPipeline(done), String(done));
}

// ---- summarize: lo que recibe el renderer
{
  // Epic #303 con probar-tarea fallido por dev ocupado y su MR sin pipeline.
  const epicJobs = [job(E.mergear, "skipped"), job(E.devolver, "manual"), job(E.validar, "skipped"), job(E.probar, "failed", { id: 59720, reason: ["Dev no está libre"] })];
  const s = R.summarize({ epicIid: 303, epic: { id: 27555, status: "failed", url: "u", jobs: epicJobs }, mrs: [{ projectId: 11, iid: 1044, pipeline: null, jobs: [] }] });
  assert.strictEqual(s.state, "probar-failed");
  assert.deepStrictEqual(s.epic.jobs.map((j) => j.name), [E.probar, E.validar, E.devolver, E.mergear]);
  assert.strictEqual(s.epic.jobs[0].action, "retry");
  assert.deepStrictEqual(s.epic.jobs[0].reason, ["Dev no está libre"], "el motivo viaja con el job");
  assert.strictEqual(s.epic.jobs[2].action, "play");
  assert.strictEqual(s.epic.jobs[2].confirm, "return");
  assert.strictEqual(s.mrs[0].state, "no-pipeline");
  assert.deepStrictEqual(s.epic.pipeline, { id: 27555, status: "failed", url: "u" });
}
{
  // Epic con la ronda cancelada: sin ▶ en ningún job.
  const s = R.summarize({ epicIid: 363, epic: { id: 26646, status: "canceled", url: "u", jobs: [job(E.probar, "manual"), job(E.devolver, "manual")] }, mrs: [] });
  assert.strictEqual(s.state, "canceled");
  assert.ok(s.epic.jobs.every((j) => j.action === null));
}
{
  // Epic sin pipeline todavía.
  const s = R.summarize({ epicIid: 400, epic: null, mrs: [] });
  assert.strictEqual(s.state, "no-pipeline");
  assert.strictEqual(s.epic.pipeline, null);
  assert.deepStrictEqual(s.epic.jobs, []);
}
{
  // Tarea sin epic: hotfix api!950. El ▶ de validar pide confirmar «sin dev» y los jobs del flujo van primero.
  const jobs = [job("sonarqube-check", "manual"), job("test", "skipped"), job(M.validar, "manual"), job(M.deploy, "skipped"), job(M.probar, "manual")];
  const s = R.summarize({ epicIid: null, epic: null, mrs: [{ projectId: 12, iid: 950, pipeline: { id: 5, status: "manual", url: "u" }, jobs }] });
  assert.strictEqual(s.epic, null);
  assert.strictEqual(s.state, "probar-ready");
  assert.deepStrictEqual(s.mrs[0].jobs.map((j) => j.name), [M.probar, M.deploy, M.validar, "sonarqube-check", "test"]);
  const validar = s.mrs[0].jobs.find((j) => j.name === M.validar);
  assert.strictEqual(validar.action, "play");
  assert.strictEqual(validar.confirm, "no-dev");
  assert.strictEqual(s.mrs[0].jobs.find((j) => j.name === "test").flow, false);
}
{
  // Epic con probar hecho y una MR aún desplegando: espera, no ofrece validar como lista.
  const epicJobs = [job(E.probar, "success"), job(E.validar, "manual"), job(E.mergear, "created"), job(E.devolver, "manual")];
  const mrs = [
    { projectId: 12, iid: 787, pipeline: { status: "success" }, jobs: [job(M.probar, "success"), job(M.deploy, "success"), job(M.validar, "manual")] },
    { projectId: 11, iid: 923, pipeline: { status: "running" }, jobs: [job(M.probar, "success"), job(M.deploy, "running"), job(M.validar, "created")] },
  ];
  assert.strictEqual(R.summarize({ epicIid: 369, epic: { id: 1, status: "manual", url: "u", jobs: epicJobs }, mrs }).state, "probando");
}

// ---- live: la tarjeta tiene algo en marcha y merece recargarse sola
{
  const mrWith = (...jobs) => ({ projectId: 12, iid: 1, pipeline: { status: "running" }, jobs });
  const epicOf = (...jobs) => ({ id: 1, status: "running", url: "u", jobs });
  // Esperando un ▶ (manual) o a la fase anterior (created) no se mueve sola: no es «live».
  assert.strictEqual(R.summarize({ epicIid: 303, epic: epicOf(job(E.probar, "manual"), job(E.validar, "created")), mrs: [] }).live, false);
  assert.strictEqual(R.summarize({ epicIid: 303, epic: epicOf(job(E.probar, "running"), job(E.validar, "created")), mrs: [] }).live, true, "job de la epic en marcha");
  assert.strictEqual(R.summarize({ epicIid: 303, epic: epicOf(job(E.probar, "success")), mrs: [mrWith(job(M.deploy, "waiting_for_resource"))] }).live, true, "job de una MR en cola");
  assert.strictEqual(R.summarize({ epicIid: null, epic: null, mrs: [mrWith(job(M.probar, "pending"))] }).live, true, "tarea sin epic");
  assert.strictEqual(R.summarize({ epicIid: null, epic: null, mrs: [mrWith(job(M.probar, "success"), job(M.deploy, "failed"))] }).live, false);
  assert.strictEqual(R.summarize({ epicIid: 400, epic: null, mrs: [] }).live, false, "sin pipeline");
}

// ---- lo que llega del renderer
{
  assert.deepStrictEqual(R.parseMrRef({ projectId: "12", iid: 7 }), { projectId: 12, iid: 7 });
  for (const bad of [{ projectId: 99, iid: 1 }, { projectId: 12, iid: 0 }, { projectId: 12, iid: "1; x" }, { projectId: 12 }, {}]) assert.throws(() => R.parseMrRef(bad), /MR/, JSON.stringify(bad));
  assert.deepStrictEqual(R.parseAct({ project: 62, jobId: "59720", kind: "retry", motivo: "x" }), { project: 62, jobId: 59720, kind: "retry", motivo: "" }, "retry no lleva motivo");
  assert.deepStrictEqual(R.parseAct({ project: "12", jobId: 7, kind: "play", motivo: "  rota  " }), { project: 12, jobId: 7, kind: "play", motivo: "rota" });
  assert.strictEqual(R.parseAct({ project: 12, jobId: 7, kind: "play", motivo: "x".repeat(900) }).motivo.length, 500);
  assert.throws(() => R.parseAct({ project: 5, jobId: 7, kind: "play" }), /Proyecto/);
  assert.throws(() => R.parseAct({ project: 12, jobId: "7; DROP", kind: "play" }), /Job/);
  assert.throws(() => R.parseAct({ project: 12, jobId: 0, kind: "play" }), /Job/);
  assert.throws(() => R.parseAct({ project: 12, jobId: 7, kind: "delete" }), /Acción/);
  assert.throws(() => R.parseAct({}), /Proyecto/);
  assert.strictEqual(R.parseEpicIid("303"), 303);
  assert.strictEqual(R.parseEpicIid(303), 303);
  for (const bad of ["0", "-1", "3x", "", null, undefined, 1.5]) assert.throws(() => R.parseEpicIid(bad), /epic/, `epic inválida: ${bad}`);
  assert.deepStrictEqual(R.parseTaskRef({ epicIid: 303, mrs: [{ projectId: 11, iid: 1044 }] }), { epicIid: 303, mrs: [{ projectId: 11, iid: 1044 }] });
  assert.deepStrictEqual(R.parseTaskRef({ epicIid: null, mrs: [] }), { epicIid: null, mrs: [] });
  assert.throws(() => R.parseTaskRef({ epicIid: 1, mrs: [{ projectId: 99, iid: 1 }] }), /MR/);
  assert.throws(() => R.parseTaskRef({ epicIid: 1, mrs: "x" }), /MR/);
  assert.throws(() => R.parseTaskRef({ epicIid: 1, mrs: Array.from({ length: 31 }, () => ({ projectId: 11, iid: 1 })) }), /MR/);
}

console.log("test-pruebas: ok");
