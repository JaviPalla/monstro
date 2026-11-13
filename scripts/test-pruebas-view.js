#!/usr/bin/env node
"use strict";

// Vista de Pruebas (renderer/app/pruebas.js). El renderer son scripts clásicos en ámbito global, así que se
// evalúa el fichero en un contexto vm con stubs de sus globales (como test-palette.js) y se comprueba lo que
// pinta y lo que lanza: escapado de lo que viene de GitLab, botones ▶/↻, doble clic, confirmaciones y
// «Nuevo pipeline». `node scripts/test-pruebas-view.js`

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "pruebas.js"), "utf8");

// Mismo contrato que esc() de core.js: nada de lo que viene de GitLab llega como HTML.
const escape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tick = () => new Promise((r) => setImmediate(r));

function load({ monstro = {}, tasks = [], storage, labels = [] } = {}) {
  const calls = { act: [], task: [], pipeline: [], run: [], board: [], open: [], toasts: [] };
  const els = new Map();
  const el = (sel) => {
    if (!els.has(sel)) {
      els.set(sel, { sel, value: "", handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; }, classList: { add() {}, remove() {} }, focus() {} });
    }
    return els.get(sel);
  };
  const chips = {}; // data-label → handler de clic, registrado al pintar (como hace wirePruebas con los botones reales)
  const chipEls = () => [...list.innerHTML.matchAll(/class="pru-chip[^"]*" data-label="([^"]*)"/g)].map((m) => ({ dataset: { label: m[1] }, addEventListener: (ev, fn) => { chips[m[1]] = fn; } }));
  // «otros jobs» (<details>): data-k → { open, toggle }, para probar que seguir abierto sobrevive a un repintado.
  const details = {};
  const detailEls = () =>
    [...list.innerHTML.matchAll(/<details class="pru-other" data-k="([^"]*)"( open)?>/g)].map((m) => {
      const d = (details[m[1]] = { dataset: { k: m[1] }, open: !!m[2], toggle: null, addEventListener(ev, fn) { if (ev === "toggle") this.toggle = fn; } });
      return d;
    });
  let renders = 0; // cuántas veces se repinta la lista
  let html = "";
  const list = {
    get innerHTML() { return html; },
    set innerHTML(v) { renders++; html = v; },
    querySelectorAll: (sel) => (sel === ".pru-chip" ? chipEls() : sel === ".pru-other" ? detailEls() : []),
  };
  const modal = { innerHTML: "" };
  // Temporizadores falsos: `v.tickTimer(n)` dispara n veces cada intervalo vivo.
  const timers = [];
  const doc = { hidden: false, querySelectorAll: () => [] };
  const ctx = {
    state: { view: "pruebas", config: { provider: "gitlab" }, pruebas: { tasks, errors: [], labels, loading: false, progress: null, busy: new Set(), labelFilter: [] } },
    list,
    $: (sel) => (sel === "#modal-root" ? modal : el(sel)),
    esc: escape,
    icon: (name) => `[${name}]`,
    t: (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => p[k] ?? `{${k}}`),
    toast: (msg, kind, onClick) => calls.toasts.push({ msg, kind, onClick }),
    isGitlab: () => true,
    closeDetail: () => {},
    notifySelftestOnce: () => {},
    JOB_ICON: new Proxy({}, { get: (_t, k) => ["·", `st-${String(k)}`] }),
    document: doc,
    setInterval: (fn, ms) => timers.push({ fn, ms, on: true }),
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].on = false; },
    window: {
      monstro: {
        pruebasAct: async (...a) => { calls.act.push(a); return { ok: true }; },
        pruebasTask: async (...a) => { calls.task.push(a); return { epic: null, mrs: [], state: "no-mrs" }; },
        pruebasNewPipeline: async (n) => { calls.pipeline.push(n); return { created: true, url: "https://g/p/1" }; },
        pruebasRunMrPipeline: async (...a) => { calls.run.push(a); return { id: 5, url: "https://g/p/5", status: "created" }; },
        pruebasBoard: async (runId) => { calls.board.push(runId); return { tasks: [], errors: [], labels: [], loaded: 0, total: 0 }; },
        onPruebasProgress: () => () => {},
        openExternal: (u) => calls.open.push(u),
        ...monstro,
      },
    },
  };
  if (storage) ctx.localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  const tickTimer = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      timers.filter((x) => x.on).forEach((x) => x.fn());
      await tick();
      await tick();
    }
  };
  return { ctx, calls, list, modal, el, chips, details, doc, timers, tickTimer, renders: () => renders, state: ctx.state };
}

const job = (over = {}) => ({ id: 1, name: "probar-tarea", stage: "probar", status: "manual", url: "https://g/job/1", projectId: 62, reason: null, flow: true, action: "play", confirm: null, ...over });
const mrSkel = { projectId: 11, iid: 1044, repo: "launcher", title: "mr", url: "https://g/m", branch: "b", draft: false, labels: [] };
const epicTask = (epicOver = {}, over = {}) => ({
  key: "epic:62#303", kind: "epic", ref: "#303", title: "Epic", url: "https://g/e/303", label: "pending check", hotfix: false, epicIid: 303, mrs: [mrSkel],
  detail: { state: "probar-ready", epic: { pipeline: { id: 7, status: "manual", url: "https://g/p/7" }, jobs: [job()], state: "probar-ready", ...epicOver }, mrs: [{ projectId: 11, iid: 1044, jobs: [], state: "no-pipeline" }] },
  ...over,
});
const plain = (kind, over = {}) => ({ key: `${kind}:1`, kind, ref: "x#1", title: "t", url: "https://g/x", label: null, hotfix: false, epicIid: null, mrs: [], detail: { state: "no-mrs", epic: null, mrs: [], }, ...over });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- pintar ---------- */

test("agrupa en Epics, Tareas sin epic y Hotfix", () => {
  const v = load({ tasks: [epicTask(), plain("issue", { key: "issue:1" }), plain("mr", { key: "mr:1", hotfix: true })] });
  v.ctx.renderPruebas();
  const h = v.list.innerHTML;
  const at = (s) => h.indexOf(`<h2>${s}`);
  assert.ok(at("Epics") > -1 && at("Tareas sin epic") > at("Epics") && at("Hotfix") > at("Tareas sin epic"), h.slice(0, 300));
});

test("todo texto de GitLab va escapado (título, ref, etiqueta, job, motivo, MR, error)", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const task = epicTask({ jobs: [job({ name: evil, status: "failed", action: "retry", reason: [evil], url: evil })] }, { title: evil, ref: evil, label: evil, url: evil });
  task.mrs = [{ ...mrSkel, title: evil, repo: evil, url: evil }];
  task.detail.mrs = [{ projectId: 11, iid: 1044, jobs: [job({ name: evil })], state: "no-pipeline", error: evil }];
  const v = load({ tasks: [task, plain("issue", { key: "issue:2", error: evil, detail: null })] });
  v.ctx.renderPruebas();
  assert.ok(!v.list.innerHTML.includes("<img"), "quedó HTML sin escapar");
  assert.ok(v.list.innerHTML.includes("&lt;img"));
});

test("el motivo del fallo se pinta bajo el job", () => {
  const v = load({ tasks: [epicTask({ jobs: [job({ status: "failed", action: "retry", reason: ["Dev no está libre", "- launcher: !1043"] })] })] });
  v.ctx.renderPruebas();
  assert.ok(v.list.innerHTML.includes('<pre class="pru-reason">Dev no está libre\n- launcher: !1043</pre>'));
});

test("una carga vieja no pisa a la nueva", async () => {
  const resolvers = [];
  const v = load({ monstro: { pruebasBoard: () => new Promise((res) => resolvers.push(res)) } });
  const p1 = v.ctx.loadPruebas();
  const p2 = v.ctx.loadPruebas();
  resolvers[1]({ tasks: [plain("issue", { key: "nueva" })], errors: [], loaded: 1, total: 1 });
  await p2;
  resolvers[0]({ tasks: [plain("issue", { key: "vieja" })], errors: [], loaded: 1, total: 1 });
  await p1;
  assert.deepStrictEqual(v.state.pruebas.tasks.map((x) => x.key), ["nueva"]);
});

/* ---------- botones ---------- */

test("▶ en el job manual, ↻ en el fallido y nada en el resto", () => {
  const jobs = [job({ id: 1, status: "manual", action: "play" }), job({ id: 2, status: "failed", action: "retry" }), job({ id: 3, status: "success", action: null })];
  const v = load({ tasks: [epicTask({ jobs })] });
  v.ctx.renderPruebas();
  const h = v.list.innerHTML;
  assert.strictEqual((h.match(/class="pru-act"/g) || []).length, 2);
  assert.ok(h.includes('data-action="play"') && h.includes('data-action="retry"'));
  assert.ok(h.includes('data-project="62"') && h.includes('data-job="1"') && h.includes('data-key="epic:62#303"'));
});

test("un job con una acción en curso lleva el botón deshabilitado", () => {
  const v = load({ tasks: [epicTask()] });
  v.state.pruebas.busy.add(1);
  v.ctx.renderPruebas();
  assert.ok(/class="pru-act"[^>]*disabled/.test(v.list.innerHTML));
});

test("«Nuevo pipeline» va dentro de cada epic (con ronda vigente, cancelada o sin pipeline) y ya no hay botón global", () => {
  const html = (tasks) => {
    const v = load({ tasks });
    v.ctx.renderPruebas();
    return v.list.innerHTML;
  };
  const count = (h) => (h.match(/class="btn pru-newpipe"/g) || []).length;
  const none = epicTask(); none.detail.epic = { pipeline: null, jobs: [], state: "no-pipeline" };
  assert.strictEqual(count(html([none])), 1);
  assert.strictEqual(count(html([epicTask({ state: "canceled" })])), 1);
  assert.strictEqual(count(html([epicTask()])), 1);
  assert.ok(html([epicTask()]).includes('data-key="epic:62#303"'), "el botón sabe de qué tarjeta es");
  assert.ok(!html([epicTask()]).includes('id="pru-new"'), "sin botón global");
  assert.strictEqual(count(html([plain("issue", { mrs: [mrSkel] })])), 0, "una tarea sin epic no crea pipelines de epic");
});

test("«Run pipeline» sale en cada MR de una tarea sin epic y de un hotfix, y no en las MRs de una epic", () => {
  const withMr = (task) => ({ ...task, mrs: [mrSkel], detail: { ...task.detail, mrs: [{ projectId: 11, iid: 1044, jobs: [], state: "no-pipeline" }] } });
  const html = (task) => {
    const v = load({ tasks: [task] });
    v.ctx.renderPruebas();
    return v.list.innerHTML;
  };
  const count = (h) => (h.match(/class="btn pru-runpipe"/g) || []).length;
  const issue = html(withMr(plain("issue", { key: "issue:11#459" })));
  assert.strictEqual(count(issue), 1);
  assert.ok(issue.includes('data-project="11"') && issue.includes('data-iid="1044"') && issue.includes('data-key="issue:11#459"'));
  assert.strictEqual(count(html(withMr(plain("mr", { key: "mr:11!1044", hotfix: true })))), 1);
  assert.strictEqual(count(html(epicTask())), 0);
});

test("«Run pipeline» con una petición en curso lleva el botón deshabilitado", () => {
  const task = { ...plain("issue", { key: "issue:11#459", mrs: [mrSkel] }) };
  task.detail.mrs = [{ projectId: 11, iid: 1044, jobs: [], state: "no-pipeline" }];
  const v = load({ tasks: [task] });
  v.state.pruebas.busy.add("run:11!1044");
  v.ctx.renderPruebas();
  assert.ok(/class="btn pru-runpipe"[^>]*disabled/.test(v.list.innerHTML));
});

/* ---------- acciones ---------- */

const ds = (over = {}) => ({ project: 62, job: 9, action: "play", name: "devolver-tarea", confirm: "", ...over });

test("doble clic: una sola petición y una sola recarga", async () => {
  const releases = [];
  const v = load({ tasks: [epicTask()], monstro: { pruebasAct: (...a) => { v.calls.act.push(a); return new Promise((r) => releases.push(r)); } } });
  const task = v.state.pruebas.tasks[0];
  const a = v.ctx.runPruAct(task, ds(), "");
  const b = v.ctx.runPruAct(task, ds(), "");
  releases.forEach((r) => r({ ok: true })); // todas las que se hayan mandado: si la guarda falla, que falle el assert y no se cuelgue
  await Promise.all([a, b]);
  assert.strictEqual(v.calls.act.length, 1, "se mandó dos veces");
  assert.strictEqual(v.calls.task.length, 1);
  assert.strictEqual(v.state.pruebas.busy.size, 0);
});

test("error de GitLab: toast rojo con el mensaje, el botón se libera y la tarjeta se recarga", async () => {
  const v = load({ tasks: [epicTask()], monstro: { pruebasAct: async () => { throw new Error("Unplayable Job"); } } });
  await v.ctx.runPruAct(v.state.pruebas.tasks[0], ds(), "");
  const t = v.calls.toasts.at(-1);
  assert.strictEqual(t.kind, "err");
  assert.ok(t.msg.includes("Unplayable Job"));
  assert.strictEqual(v.state.pruebas.busy.size, 0);
  assert.strictEqual(v.calls.task.length, 1);
});

test("tras una acción se recarga solo esa tarjeta, con su epic y sus MRs", async () => {
  const detail = { epic: null, mrs: [], state: "no-mrs" };
  const v = load({ tasks: [epicTask()], monstro: { pruebasTask: async (...a) => { v.calls.task.push(a); return detail; } } });
  const task = v.state.pruebas.tasks[0];
  await v.ctx.runPruAct(task, ds({ action: "retry" }), "");
  // JSON y no deepStrictEqual: los objetos los crea el script dentro del contexto vm (otro realm, otros prototipos).
  assert.strictEqual(JSON.stringify(v.calls.task[0]), JSON.stringify([303, [{ projectId: 11, iid: 1044 }]]));
  assert.strictEqual(task.detail, detail);
  assert.strictEqual(v.calls.toasts.at(-1).kind, "ok");
});

test("devolver pide motivo y lo envía recortado", async () => {
  const v = load({ tasks: [epicTask()] });
  v.ctx.confirmPruAct(v.state.pruebas.tasks[0], ds({ confirm: "return" }));
  assert.ok(v.modal.innerHTML.includes('id="pru-motivo"'));
  v.el("#pru-motivo").value = "  falta X ";
  v.el("#modal-confirm").handlers.click();
  await tick();
  assert.deepStrictEqual(v.calls.act[0], [62, 9, "play", "falta X"]);
  assert.strictEqual(v.modal.innerHTML, "");
});

test("reintentar devolver no pide motivo", async () => {
  const v = load({ tasks: [epicTask()] });
  v.ctx.confirmPruAct(v.state.pruebas.tasks[0], ds({ confirm: "return", action: "retry" }));
  assert.ok(!v.modal.innerHTML.includes("pru-motivo"));
  v.el("#modal-confirm").handlers.click();
  await tick();
  assert.deepStrictEqual(v.calls.act[0], [62, 9, "retry", ""]);
});

test("cancelar la confirmación no lanza nada", async () => {
  const v = load({ tasks: [epicTask()] });
  v.ctx.confirmPruAct(v.state.pruebas.tasks[0], ds({ confirm: "merge", name: "mergear-tarea" }));
  assert.ok(v.modal.innerHTML.includes("Mergear la tarea"));
  v.el("#modal-cancel").handlers.click();
  await tick();
  assert.strictEqual(v.calls.act.length, 0);
  assert.strictEqual(v.modal.innerHTML, "");
});

test("validar sin dev avisa antes de lanzar", () => {
  const v = load({ tasks: [epicTask()] });
  v.ctx.confirmPruAct(v.state.pruebas.tasks[0], ds({ confirm: "no-dev", name: "validar-tarea-para-mergear", project: 12 }));
  assert.ok(v.modal.innerHTML.includes("Validar sin dev"));
});

test("Nuevo pipeline: crea, el aviso abre el pipeline y se recarga solo esa tarjeta", async () => {
  const v = load({ tasks: [epicTask()] });
  await v.ctx.runPruNewPipeline(v.state.pruebas.tasks[0]);
  assert.deepStrictEqual(v.calls.pipeline, [303]);
  const t = v.calls.toasts.at(-1);
  assert.strictEqual(t.kind, "ok");
  t.onClick();
  assert.deepStrictEqual(v.calls.open, ["https://g/p/1"]);
  assert.strictEqual(v.calls.task.length, 1, "recarga la tarjeta");
  assert.strictEqual(v.calls.board.length, 0, "y no la lista entera");
});

test("Nuevo pipeline: si ya hay una ronda vigente lo dice y no lo presenta como creado", async () => {
  const v = load({ tasks: [epicTask()], monstro: { pruebasNewPipeline: async () => ({ created: false, url: "https://g/p/9" }) } });
  await v.ctx.runPruNewPipeline(v.state.pruebas.tasks[0]);
  const t = v.calls.toasts.at(-1);
  assert.strictEqual(t.kind, "");
  assert.ok(t.msg.includes("ya tiene un pipeline vigente"));
});

test("Nuevo pipeline: el error de GitLab sale en un toast rojo", async () => {
  const v = load({ tasks: [epicTask()], monstro: { pruebasNewPipeline: async () => { throw new Error("La epic #5 no está abierta"); } } });
  await v.ctx.runPruNewPipeline(v.state.pruebas.tasks[0]);
  assert.strictEqual(v.calls.toasts.at(-1).kind, "err");
  assert.ok(v.calls.toasts.at(-1).msg.includes("no está abierta"));
});

test("Nuevo pipeline: doble clic crea una sola ronda (el bot no cancela las que crea una persona)", async () => {
  const releases = [];
  const v = load({ tasks: [epicTask()], monstro: { pruebasNewPipeline: (n) => { v.calls.pipeline.push(n); return new Promise((r) => releases.push(r)); } } });
  const task = v.state.pruebas.tasks[0];
  const a = v.ctx.runPruNewPipeline(task);
  const b = v.ctx.runPruNewPipeline(task);
  releases.forEach((r) => r({ created: true, url: "https://g/p/1" }));
  await Promise.all([a, b]);
  assert.deepStrictEqual(v.calls.pipeline, [303], "se pidió dos veces");
  assert.strictEqual(v.state.pruebas.busy.size, 0, "la guarda se libera");
  const c = v.ctx.runPruNewPipeline(task); // ya terminó: otra petición posterior sí vale
  releases.forEach((r) => r({ created: true, url: "https://g/p/1" }));
  await c;
  assert.deepStrictEqual(v.calls.pipeline, [303, 303]);
});

const mrTask = () => plain("mr", { key: "mr:11!1044", hotfix: true, mrs: [mrSkel] });

test("Run pipeline: lanza el de esa MR, avisa y recarga solo esa tarjeta", async () => {
  const v = load({ tasks: [mrTask()] });
  await v.ctx.runPruMrPipeline(v.state.pruebas.tasks[0], 11, 1044);
  assert.deepStrictEqual(v.calls.run, [[11, 1044]]);
  assert.strictEqual(v.calls.toasts.at(-1).kind, "ok");
  assert.strictEqual(v.calls.task.length, 1);
  assert.strictEqual(v.calls.board.length, 0);
  assert.strictEqual(v.state.pruebas.busy.size, 0);
});

test("Run pipeline: el error de GitLab sale en un toast rojo y la tarjeta se recarga igual", async () => {
  const v = load({ tasks: [mrTask()], monstro: { pruebasRunMrPipeline: async () => { throw new Error("Insufficient permissions"); } } });
  await v.ctx.runPruMrPipeline(v.state.pruebas.tasks[0], 11, 1044);
  assert.strictEqual(v.calls.toasts.at(-1).kind, "err");
  assert.ok(v.calls.toasts.at(-1).msg.includes("Insufficient permissions"));
  assert.strictEqual(v.calls.task.length, 1);
  assert.strictEqual(v.state.pruebas.busy.size, 0);
});

test("Run pipeline: doble clic manda una sola petición", async () => {
  const releases = [];
  const v = load({ tasks: [mrTask()], monstro: { pruebasRunMrPipeline: (...a) => { v.calls.run.push(a); return new Promise((r) => releases.push(r)); } } });
  const task = v.state.pruebas.tasks[0];
  const a = v.ctx.runPruMrPipeline(task, 11, 1044);
  const b = v.ctx.runPruMrPipeline(task, 11, 1044);
  releases.forEach((r) => r({ id: 5 }));
  await Promise.all([a, b]);
  assert.strictEqual(v.calls.run.length, 1, "se mandó dos veces");
});

test("mergear-tarea en marcha se pinta como «Mergeando» y no como estado desconocido", () => {
  const v = load({ tasks: [epicTask({ state: "mergeando" }, { detail: { state: "mergeando", epic: { pipeline: { id: 7, status: "running", url: "u" }, jobs: [], state: "mergeando" }, mrs: [] } })] });
  v.ctx.renderPruebas();
  assert.ok(v.list.innerHTML.includes(">Mergeando<"), "falta el chip");
});


/* ---------- etiquetas y filtro ---------- */

const KEY = "monstro:pruebas-labels";
const json = (x) => JSON.stringify(x); // los arrays del contexto vm tienen otro prototipo: se comparan por JSON

test("la tarjeta muestra sus etiquetas (sin repetir la de ciclo) y las QA: van primero y destacadas", () => {
  const v = load({ tasks: [plain("issue", { label: "pending check", labels: ["pending check", "enhancement", "QA: alejandro"] })] });
  v.ctx.renderPruebas();
  const tags = [...v.list.innerHTML.matchAll(/<span class="pru-tag( qa)?">([^<]*)<\/span>/g)].map((m) => `${m[1] ? "qa " : ""}${m[2]}`);
  assert.strictEqual(json(tags), json(["qa QA: alejandro", "enhancement"]));
});

test("solo son QA las etiquetas «QA: nombre» (sin distinguir mayúsculas ni espacios) y no cualquiera que empiece por qa", () => {
  const v = load({ tasks: [plain("issue", { labels: ["qa:ana", "Qa : luis", "qazar", "quality"] })] });
  v.ctx.renderPruebas();
  const tags = [...v.list.innerHTML.matchAll(/<span class="pru-tag( qa)?">([^<]*)<\/span>/g)].map((m) => `${m[1] ? "qa " : ""}${m[2]}`);
  assert.strictEqual(json(tags), json(["qa Qa : luis", "qa qa:ana", "qazar", "quality"]));
});

test("barra de filtro: un chip por etiqueta con su contador, las QA: primero y los dos Alejandro por separado", () => {
  const v = load({ tasks: [
    plain("issue", { key: "a", labels: ["pending check", "QA: alejandro", "enhancement"] }),
    plain("issue", { key: "b", labels: ["pending check", "QA: alejandro.perez", "enhancement"] }),
    plain("issue", { key: "c", labels: ["pending check"] }),
  ] });
  v.ctx.renderPruebas();
  const chips = [...v.list.innerHTML.matchAll(/<button class="pru-chip[^"]*" data-label="([^"]*)"[^>]*>[^<]*<span>(\d+)<\/span>/g)].map((m) => `${m[1]}=${m[2]}`);
  assert.strictEqual(json(chips), json(["QA: alejandro=1", "QA: alejandro.perez=1", "enhancement=2", "pending check=3"]));
});

test("elegir etiquetas deja solo las tareas que las tienen todas; los contadores de grupo lo reflejan; otra pulsación la quita", () => {
  const v = load({ tasks: [
    plain("issue", { key: "issue:a", title: "AAA", labels: ["QA: alejandro", "enhancement"] }),
    plain("issue", { key: "issue:b", title: "BBB", labels: ["QA: alejandro.perez", "enhancement"] }),
    plain("mr", { key: "mr:c", title: "CCC", hotfix: true, labels: [] }),
  ] });
  v.ctx.renderPruebas();
  v.chips.enhancement(); // clic real en el chip
  let h = v.list.innerHTML;
  assert.ok(h.includes("AAA") && h.includes("BBB") && !h.includes("CCC"), "enhancement");
  v.chips["QA: alejandro"]();
  h = v.list.innerHTML;
  assert.ok(h.includes("AAA") && !h.includes("BBB") && !h.includes("CCC"), "enhancement + QA: alejandro");
  assert.ok(h.includes('<span class="pru-count">1</span>') && !h.includes("<h2>Hotfix"));
  assert.ok(h.includes('class="pru-chip qa on" data-label="QA: alejandro"'), "el chip activo se marca");
  v.chips["QA: alejandro"]();
  assert.ok(v.list.innerHTML.includes("BBB"));
});

test("sin tareas con esa etiqueta: aviso, y la barra sigue con el chip activo y «Quitar filtro»", () => {
  const v = load({ tasks: [plain("issue", { labels: ["enhancement"] })] });
  v.state.pruebas.labelFilter = ["QA: nadie"];
  v.ctx.renderPruebas();
  const h = v.list.innerHTML;
  assert.ok(h.includes("Ninguna tarea con esas etiquetas") && !h.includes("No hay tareas por probar"));
  assert.ok(h.includes('data-label="QA: nadie"') && h.includes('id="pru-clear-labels"'));
  v.el("#pru-clear-labels").handlers.click();
  assert.strictEqual(json(v.state.pruebas.labelFilter), "[]");
  assert.ok(!v.list.innerHTML.includes("Ninguna tarea"));
});

test("la selección se guarda al elegir y se recupera al entrar en la sección", async () => {
  const store = {};
  const v = load({ tasks: [plain("issue", { labels: ["QA: alejandro"] })], storage: store });
  v.ctx.togglePruLabel("QA: alejandro");
  assert.strictEqual(store[KEY], json(["QA: alejandro"]));
  const w = load({ storage: { [KEY]: json(["QA: alejandro"]) } });
  await w.ctx.enterPruebas();
  assert.strictEqual(json(w.state.pruebas.labelFilter), json(["QA: alejandro"]));
});

test("sin almacenamiento o con uno corrupto no falla: filtra en memoria", async () => {
  const v = load({ tasks: [plain("issue", { labels: ["enhancement"] })] }); // sin localStorage
  v.ctx.togglePruLabel("enhancement");
  assert.strictEqual(json(v.state.pruebas.labelFilter), json(["enhancement"]));
  for (const bad of ["no es json", '{"a":1}', "[1,null]"]) {
    const w = load({ storage: { [KEY]: bad } });
    await w.ctx.enterPruebas();
    assert.strictEqual(json(w.state.pruebas.labelFilter), "[]", bad);
  }
});

test("las etiquetas de GitLab van escapadas en el chip, el data-label y la etiqueta de la tarjeta", () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const v = load({ tasks: [plain("issue", { labels: [evil] })] });
  v.state.pruebas.labelFilter = [evil];
  v.ctx.renderPruebas();
  assert.ok(!v.list.innerHTML.includes("<img"), "quedó HTML sin escapar");
  assert.ok(v.list.innerHTML.includes("&lt;img") && v.list.innerHTML.includes("&quot;"));
});

/* ---------- todas las etiquetas del grupo ---------- */

const chipsOf = (h) => [...h.matchAll(/<button class="pru-chip([^"]*)" data-label="([^"]*)"[^>]*>[^<]*<span>(\d+)<\/span>/g)].map((m) => `${m[2]}=${m[3]}${m[1].includes("zero") ? "!" : ""}`);

test("la barra ofrece todas las etiquetas del grupo: QA primero, luego con tareas y al final las de 0 (atenuadas)", () => {
  const v = load({
    labels: ["AI", "QA: Daniel", "QA: alejandro", "QA: javipalla", "enhancement", "hotfix", "pending check"],
    tasks: [plain("issue", { labels: ["pending check", "QA: alejandro", "enhancement"] })],
  });
  v.ctx.renderPruebas();
  assert.strictEqual(json(chipsOf(v.list.innerHTML)), json(["QA: alejandro=1", "QA: Daniel=0!", "QA: javipalla=0!", "enhancement=1", "pending check=1", "AI=0!", "hotfix=0!"]));
});

test("sin etiquetas de grupo (falló la petición) la barra sale de las tareas, como antes", () => {
  const v = load({ labels: [], tasks: [plain("issue", { labels: ["pending check", "enhancement"] })] });
  v.ctx.renderPruebas();
  assert.strictEqual(json(chipsOf(v.list.innerHTML)), json(["enhancement=1", "pending check=1"]));
});

test("filtrar por la etiqueta QA de un compañero sin tareas avisa, no rompe", () => {
  const v = load({ labels: ["QA: Daniel"], tasks: [plain("issue", { labels: ["enhancement"] })] });
  v.ctx.renderPruebas();
  v.chips["QA: Daniel"]();
  assert.ok(v.list.innerHTML.includes("Ninguna tarea con esas etiquetas"));
});

/* ---------- tiempo real ---------- */

const liveTask = (key = "epic:62#303") => epicTask({}, { key, detail: { ...epicTask().detail, live: true } });
const idleTask = () => epicTask({}, { key: "epic:62#400", epicIid: 400, ref: "#400", detail: { ...epicTask().detail, live: false } });

test("al entrar arranca un sondeo y al salir de la vista se para", async () => {
  const v = load({ tasks: [liveTask()] });
  await v.ctx.enterPruebas();
  assert.strictEqual(v.timers.filter((x) => x.on).length, 1);
  v.state.view = "prs";
  await v.tickTimer();
  assert.strictEqual(v.timers.filter((x) => x.on).length, 0, "el tick se da de baja");
  assert.strictEqual(v.calls.task.length, 0);
});

test("cada tick recarga solo las tarjetas con algo en marcha", async () => {
  const v = load({ tasks: [liveTask(), idleTask()] });
  await v.ctx.enterPruebas();
  v.state.pruebas.tasks = [liveTask(), idleTask()]; // enterPruebas cargó un tablero vacío
  await v.tickTimer();
  assert.strictEqual(v.calls.task.length, 1);
  assert.strictEqual(v.calls.task[0][0], 303);
});

test("con la ventana oculta o durante una carga visible no sondea", async () => {
  const v = load({ tasks: [liveTask()] });
  await v.ctx.enterPruebas();
  v.state.pruebas.tasks = [liveTask()];
  v.doc.hidden = true;
  await v.tickTimer();
  v.doc.hidden = false;
  v.state.pruebas.loading = true;
  await v.tickTimer();
  assert.strictEqual(v.calls.task.length, 0);
  assert.strictEqual(v.calls.board.length, 1, "solo la carga de entrada");
});

test("un tick lento no se repite: la tarjeta con recarga en curso no se vuelve a pedir", async () => {
  const releases = [];
  const v = load({ tasks: [liveTask()], monstro: { pruebasTask: (...a) => { v.calls.task.push(a); return new Promise((r) => releases.push(r)); } } });
  await v.ctx.enterPruebas();
  v.state.pruebas.tasks = [liveTask()];
  await v.tickTimer(3);
  assert.strictEqual(v.calls.task.length, 1);
  releases.forEach((r) => r({ epic: null, mrs: [], state: "no-mrs", live: false }));
  await tick();
  await v.tickTimer();
  assert.strictEqual(v.calls.task.length, 1, "ya no está en marcha");
});

test("la tarjeta se actualiza sola y, si no cambió nada, no se repinta", async () => {
  const v = load({ tasks: [liveTask()], monstro: { pruebasTask: async () => ({ ...liveTask().detail, state: "probando" }) } });
  await v.ctx.enterPruebas();
  v.state.pruebas.tasks = [liveTask()];
  await v.tickTimer();
  assert.strictEqual(v.state.pruebas.tasks[0].detail.state, "probando");
  const before = v.renders();
  await v.tickTimer(); // misma respuesta
  assert.strictEqual(v.renders(), before, "repintó sin cambios");
});

test("un fallo transitorio del sondeo deja la tarjeta como estaba (no la sustituye por un error)", async () => {
  const v = load({ tasks: [liveTask()], monstro: { pruebasTask: async () => { throw new Error("ETIMEDOUT"); } } });
  await v.ctx.enterPruebas();
  v.state.pruebas.tasks = [liveTask()];
  await v.tickTimer();
  assert.strictEqual(v.state.pruebas.tasks[0].error, undefined);
  assert.ok(v.state.pruebas.tasks[0].detail);
});

test("cada 6 ticks (pollSeconds / 10 s) recarga la lista en silencio: sin «Cargando», sin vaciar y sin pisar el detalle", async () => {
  const seen = [];
  const boards = [
    { tasks: [idleTask()], errors: [], labels: [], loaded: 1, total: 1 },
    { tasks: [plain("issue", { key: "nueva", title: "NUEVA" }), idleTask()], errors: [], labels: ["QA: Daniel"], loaded: 2, total: 2 },
  ];
  const v = load({ monstro: { pruebasBoard: async (runId) => { v.calls.board.push(runId); seen.push(v.state.pruebas.loading); return boards[Math.min(seen.length - 1, 1)]; } } });
  await v.ctx.enterPruebas();
  assert.ok(!v.list.innerHTML.includes("NUEVA"));
  assert.strictEqual(v.calls.board.length, 1);
  await v.tickTimer(5);
  assert.strictEqual(v.calls.board.length, 1, "aún no toca");
  await v.tickTimer();
  assert.strictEqual(v.calls.board.length, 2);
  assert.strictEqual(seen[1], false, "una recarga silenciosa no marca loading");
  assert.ok(v.list.innerHTML.includes("NUEVA"), "ve la tarea nueva");
  assert.ok(v.list.innerHTML.includes('data-label="QA: Daniel"'), "y las etiquetas nuevas");
});

test("si la recarga silenciosa falla no sale ningún error ni se pierde lo que había", async () => {
  let fail = false;
  const v = load({ tasks: [], monstro: { pruebasBoard: async () => { if (fail) throw new Error("VPN caída"); return { tasks: [plain("issue", { title: "ANTES" })], errors: [], labels: [], loaded: 1, total: 1 }; } } });
  await v.ctx.enterPruebas();
  fail = true;
  await v.tickTimer(6);
  assert.ok(v.list.innerHTML.includes("ANTES"));
  assert.ok(!v.list.innerHTML.includes("VPN caída"));
});

test("una recarga silenciosa idéntica no repinta", async () => {
  const board = { tasks: [plain("issue", { title: "IGUAL" })], errors: [], labels: ["AI"], loaded: 1, total: 1 };
  const v = load({ monstro: { pruebasBoard: async () => JSON.parse(JSON.stringify(board)) } });
  await v.ctx.enterPruebas();
  const before = v.renders();
  await v.tickTimer(6);
  assert.strictEqual(v.renders(), before);
});

test("«Recargar» manual gana a una recarga silenciosa en vuelo", async () => {
  const resolvers = [];
  const v = load({ monstro: { pruebasBoard: () => new Promise((res) => resolvers.push(res)) } });
  const first = v.ctx.enterPruebas();
  resolvers[0]({ tasks: [], errors: [], labels: [], loaded: 0, total: 0 });
  await first;
  await v.tickTimer(5);
  const silent = v.tickTimer(1); // el 6.º dispara la silenciosa y queda en vuelo
  const manual = v.ctx.loadPruebas();
  resolvers[2]({ tasks: [plain("issue", { key: "manual" })], errors: [], labels: [], loaded: 1, total: 1 });
  await manual;
  resolvers[1]({ tasks: [plain("issue", { key: "silenciosa" })], errors: [], labels: [], loaded: 1, total: 1 });
  await silent;
  assert.deepStrictEqual(v.state.pruebas.tasks.map((x) => x.key), ["manual"]);
});

test("una recarga completa lenta no se apila: mientras siga en vuelo, el sondeo no lanza otra", async () => {
  const resolvers = [];
  const v = load({ monstro: { pruebasBoard: () => new Promise((res) => resolvers.push(res)) } });
  const first = v.ctx.enterPruebas();
  resolvers[0]({ tasks: [], errors: [], labels: [], loaded: 0, total: 0 });
  await first;
  await v.tickTimer(18); // tres vueltas de 6 ticks: solo la primera lanza la silenciosa
  assert.strictEqual(resolvers.length, 2);
  resolvers[1]({ tasks: [], errors: [], labels: [], loaded: 0, total: 0 });
  await tick();
  await v.tickTimer(6); // liberada: la siguiente vuelta sí vuelve a recargar
  assert.strictEqual(resolvers.length, 3);
});

test("«otros jobs» abierto sigue abierto tras repintar", () => {
  const task = epicTask();
  task.detail.mrs = [{ projectId: 11, iid: 1044, state: "no-pipeline", jobs: [job({ id: 9, name: "lint", flow: false, action: null, status: "success" })] }];
  const v = load({ tasks: [task] });
  v.ctx.renderPruebas();
  assert.ok(!/<details class="pru-other"[^>]*open/.test(v.list.innerHTML));
  v.details["11!1044"].open = true;
  v.details["11!1044"].toggle(); // el usuario lo abre
  v.ctx.renderPruebas();
  assert.ok(/<details class="pru-other" data-k="11!1044" open>/.test(v.list.innerHTML), "se cerró al repintar");
});

// Una promesa que nunca se resuelve deja el bucle vacío y Node sale con 0: sin esto un test colgado pasaría en verde.
let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.error("test-pruebas-view: terminó sin completar (promesa pendiente)");
    process.exitCode = 1;
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${name}\n    ${String(e.message).split("\n")[0]}`);
    }
  }
  completed = true;
  if (failed) {
    console.error(`\n${failed} de ${tests.length} fallan`);
    process.exit(1);
  }
  console.log("test-pruebas-view: ok");
})();
