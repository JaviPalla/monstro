#!/usr/bin/env node
"use strict";

/**
 * "Probar en local" (src/local-run.js): catálogo, comandos, puertos y plan.
 *
 * Lo que se prueba aquí es lo que NO se ve hasta que falla delante del usuario: que notifications
 * arranque siempre por run-local.sh (el perfil Development consumiría las colas del dev compartido y
 * mandaría emails de verdad), que un valor con comillas no pueda escaparse del comando, que el puerto
 * se corra cuando el de por defecto está cogido y que /etc/hosts se proponga, nunca se toque.
 *
 * Y que main no mande frases: todo motivo/aviso viaja como `{ code, ...params }` y el texto lo pone el
 * renderer, así que aquí se comprueba que los tres lados (main, LR_TEXT, i18n) no se separen.
 *
 * `node scripts/test-local-run.js`
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const lr = require("../src/local-run");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const OHC = "OpenSaludGroup/openhealthcareapi";
const NOTIFICATIONS = "OpenSaludGroup/microservices/notifications_api";
const LAUNCHER = "OpenSaludGroup/openhealthcare-launcher";
const DASHBOARD = "OpenSaludGroup/dashboard";
const LANDING = "OpenSaludGroup/landing-profesionales";

/* ---------- catálogo ---------- */

assert.strictEqual(lr.lookup(OHC).kind, "api");
assert.strictEqual(lr.lookup(LANDING).kind, "front");
assert.strictEqual(lr.blockedReason(OHC), null);
assert.deepStrictEqual(lr.blockedReason("OpenSaludGroup/opensalud"), { code: "windows-only", name: "Ouicare", iis: true });
assert.deepStrictEqual(lr.blockedReason("OpenSaludGroup/webjob"), { code: "windows-only", name: "Webjob" });
assert.deepStrictEqual(lr.blockedReason("OpenSaludGroup/opensalud_mobile_app"), { code: "flutter" });
assert.deepStrictEqual(lr.blockedReason("libraries/JWTToken"), { code: "nuget-library", name: "JWTToken" });
assert.deepStrictEqual(lr.blockedReason("libraries/middlewares"), { code: "nuget-library", name: "middlewares" });
assert.deepStrictEqual(lr.blockedReason("OpenSaludGroup/lo-que-sea"), lr.UNKNOWN);
// Copia, no el objeto del catálogo: un ítem no puede tocarle el motivo al siguiente.
assert.notStrictEqual(lr.blockedReason("libraries/JWTToken"), lr.BLOCKED["libraries/JWTToken"]);

/* ---------- códigos: main ⇄ renderer (LR_TEXT) ⇄ i18n ---------- */

// Un ejemplo por familia y por código: main NO manda frases, así que un código nuevo sin texto en el
// renderer (o sin su EN en i18n.js) saldría en pantalla como "port-moved" y nadie se enteraría hasta
// verlo. Si añades uno en src/local-run.js o src/ipc/local-run.js, añádelo también aquí.
const SAMPLES = {
  // needs: etiqueta corta de lo que falta
  needs: [
    { code: "env-file", file: "openhealthcareapi/.env" },
    { code: "dotnet" },
    { code: "dev-certs" },
    { code: "docker" },
    { code: "node-modules" },
    { code: "pnpm" },
    { code: "hosts-entry", host: "localdashboard.opensalud.es" },
  ],
  // warnings: se puede arrancar, pero hay que saberlo
  warnings: [
    { code: "dashboard-fixed-api", url: "https://localhost:44381" },
    { code: "override-file", file: ".env.local" },
    { code: "landing-cors" },
    { code: "dotnet-missing" },
    { code: "dev-certs-missing" },
    { code: "pnpm-missing" },
    { code: "hosts-missing", host: "localdesarrollo.opensalud.es" },
    { code: "fixed-port-busy", port: 5002 },
    { code: "port-moved", defaultPort: 8080, port: 8081 },
    { code: "new-worktree-env", branch: "feat/x", file: "openhealthcareapi/.env" },
    { code: "new-worktree-env-copy", branch: "feat/x", file: "openhealthcareapi/.env" },
    { code: "env-copy", file: "openhealthcareapi/.env" },
    { code: "new-worktree-modules", branch: "feat/x" },
    { code: "mr-branch-unknown", iid: 42 },
    { code: "worktree-failed", branch: "feat/x", error: "fatal: ya existe" },
  ],
  // blocked: arrancar no tendría sentido
  blocked: [
    { code: "env-missing", file: "openhealthcareapi/.env" },
    { code: "docker-down" },
    { code: "node-modules-missing" },
    { code: "node-modules-worktree" },
    { code: "no-free-port", from: 8080, to: 8099 },
    { code: "windows-only", name: "Ouicare", iis: true },
    { code: "nuget-library", name: "JWTToken" },
    { code: "flutter" },
    { code: "not-in-catalogue" },
    { code: "no-clone" },
    { code: "no-local-dir" },
  ],
  // skipped[].reason de localRun:start (además de cualquier código de `blocked`)
  skipped: [
    { code: "not-in-session" },
    { code: "no-plan" },
    { code: "dir-gone", dir: "/Users/x/repos/launcher" },
    { code: "launch-failed", error: "Ghostty no responde" },
  ],
};

const sampleCodes = new Set(Object.values(SAMPLES).flat().map((x) => x.code));

// Lo que main puede emitir de verdad: todo `{ code: "…" }` de los dos ficheros. Por eso allí los códigos
// se escriben literales: un `code: x ? "a" : "b"` se escaparía de este guardián.
const mainSrc = read("src/local-run.js") + read("src/ipc/local-run.js");
const emitted = new Set([...mainSrc.matchAll(/\bcode:\s*"([\w-]+)"/g)].map((m) => m[1]));
for (const code of emitted) assert.ok(sampleCodes.has(code), `código sin ejemplo en SAMPLES: ${code}`);
for (const code of sampleCodes) assert.ok(emitted.has(code), `código en SAMPLES que main ya no emite: ${code}`);

// El renderer traduce por código: LR_TEXT tiene que cubrirlos todos.
const rendererSrc = read("renderer/app/sessions-local.js");
const table = rendererSrc.slice(rendererSrc.indexOf("const LR_TEXT = {"), rendererSrc.indexOf("\n};", rendererSrc.indexOf("const LR_TEXT = {")));
assert.ok(table.includes("hosts-entry"), "no encuentro la tabla LR_TEXT en sessions-local.js");
const mapped = new Set([...table.matchAll(/^\s*"?([\w-]+)"?:\s*\(/gm)].map((m) => m[1]));
for (const code of sampleCodes) assert.ok(mapped.has(code), `código sin texto en LR_TEXT (sessions-local.js): ${code}`);
for (const code of mapped) assert.ok(sampleCodes.has(code), `texto en LR_TEXT de un código que ya nadie emite: ${code}`);

// Y cada frase española de esa tabla tiene que tener su EN: si no, el panel se queda en spanglish.
const i18nSrc = read("renderer/app/i18n.js");
for (const [, es] of table.matchAll(/\bt\("([^"]+)"/g)) {
  assert.ok(i18nSrc.includes(`"${es}":`), `falta la traducción EN en i18n.js de: ${es}`);
}

/* ---------- comandos ---------- */

assert.strictEqual(
  lr.buildCommand(lr.CATALOG[OHC], { port: 44381 }),
  "dotnet run --launch-profile 'openhealthcareapi' -- --urls 'https://localhost:44381'",
);
assert.strictEqual(
  lr.buildCommand(lr.CATALOG["OpenSaludGroup/microservices/usermanagement_api"], { port: 5003 }),
  "dotnet run --launch-profile 'UserManagement' -- --urls 'https://localhost:5003'",
);

// Notifications: SIEMPRE el script (perfil Local con LocalStack+Mongo), nunca un dotnet run a pelo.
const notifications = lr.buildCommand(lr.CATALOG[NOTIFICATIONS], { port: 5002 });
assert.strictEqual(notifications, "./run-local.sh");
assert.ok(!/Development/.test(notifications) && !/dotnet run/.test(notifications));
assert.ok(!("profile" in lr.CATALOG[NOTIFICATIONS]));
assert.strictEqual(lr.CATALOG[NOTIFICATIONS].fixedPort, true);

// Front: prefijo de entorno + puerto. Solo se sobrescribe la API que SÍ se arranca.
assert.strictEqual(
  lr.buildCommand(lr.CATALOG[LAUNCHER], { port: 8080, pointsTo: { api: "https://localhost:44381", notifications: "https://localhost:5002" } }),
  "nvm use && LOCAL_ENVIRONMENT='development' LOCAL_ENV_API='https://localhost:44381' LOCAL_ENV_NOTIFICATIONS='https://localhost:5002' pnpm dev --port 8080",
);
assert.strictEqual(
  lr.buildCommand(lr.CATALOG[LAUNCHER], { port: 8082, pointsTo: { api: "https://localhost:44382" } }),
  "nvm use && LOCAL_ENVIRONMENT='development' LOCAL_ENV_API='https://localhost:44382' pnpm dev --port 8082",
);
assert.strictEqual(
  lr.buildCommand(lr.CATALOG[DASHBOARD], { port: 8081 }),
  "nvm use && pnpm dev --port 8081 --host",
);
assert.strictEqual(
  lr.buildCommand(lr.CATALOG[LANDING], { port: 3000, pointsTo: { api: "https://localhost:44381", notifications: "https://localhost:5002" } }),
  "nvm use && API_LOCAL_DOMAIN='https://localhost:44381' pnpm dev --port 3000",
);

// Nada interpolado puede cerrar las comillas ni colar un comando detrás.
const nasty = lr.buildCommand(lr.CATALOG[LANDING], { port: 3000, pointsTo: { api: "'; rm -rf ~" } });
assert.ok(nasty.includes(`API_LOCAL_DOMAIN=''\\''; rm -rf ~'`), nasty);
assert.ok(!/^[^']*; rm -rf ~/.test(nasty.replace("API_LOCAL_DOMAIN=", "")));
for (const port of ["8080; rm -rf ~", -1, 70000, 1.5, null, "abc"]) {
  assert.throws(() => lr.buildCommand(lr.CATALOG[DASHBOARD], { port }), /Puerto no válido/);
}

/* ---------- /etc/hosts (Monstro solo da la línea: tocarlo pide sudo) ---------- */

assert.strictEqual(lr.hostsLineFor([]), null);
assert.strictEqual(lr.hostsLineFor(["localdashboard.opensalud.es"]), "127.0.0.1 localdashboard.opensalud.es");
assert.strictEqual(lr.hostsLineFor(["a.es", "b.es", "a.es"]), "127.0.0.1 a.es b.es");

/* ---------- override en el .env.local del worktree: un bloque de Monstro, lo demás intacto ---------- */

const withBlock = lr.withOverrides("LOCAL_ENVIRONMENT=local\n", { LOCAL_ENV_API: "https://localhost:44381" });
assert.ok(withBlock.startsWith("LOCAL_ENVIRONMENT=local\n\n# >>> Monstro"), withBlock);
assert.ok(withBlock.endsWith("\nLOCAL_ENV_API=https://localhost:44381\n# <<< Monstro\n"), withBlock);
// Reescribir sustituye el bloque (no lo duplica) y quitarlo deja lo tuyo como estaba.
assert.strictEqual(lr.withOverrides(withBlock, { LOCAL_ENV_API: "https://localhost:44382" }).match(/# >>> Monstro/g).length, 1);
assert.ok(lr.withOverrides(withBlock, { LOCAL_ENV_API: "https://localhost:44382" }).includes("44382") && !lr.withOverrides(withBlock, { LOCAL_ENV_API: "https://localhost:44382" }).includes("44381"));
assert.strictEqual(lr.withOverrides(withBlock, {}), "LOCAL_ENVIRONMENT=local\n");
assert.strictEqual(lr.withOverrides("", {}), "");

(async () => {
  /* ---------- puertos: el de por defecto cogido → el siguiente hueco ---------- */

  const busy = net.createServer();
  // Sin host: node escucha en `::` como hacen vite y nuxt. Mirar solo 127.0.0.1 lo daría por libre.
  await new Promise((resolve) => busy.listen({ port: 0 }, resolve));
  const taken = busy.address().port;
  assert.strictEqual(await lr.portFree(taken), false);
  assert.strictEqual(await lr.freePort(taken), taken + 1);
  // Un puerto ya asignado a otro ítem del mismo plan tampoco se reparte dos veces.
  assert.strictEqual(await lr.freePort(taken, new Set([taken + 1])), taken + 2);
  await new Promise((resolve) => busy.close(resolve));
  assert.strictEqual(await lr.freePort(taken), taken);

  /* ---------- sonda ---------- */

  const server = http.createServer((_req, res) => res.end("Healthy"));
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  assert.strictEqual(await lr.probe(url, "Healthy"), true);
  assert.strictEqual(await lr.probe(url, "Unhealthy"), false);
  assert.strictEqual(await lr.probe(url, null), true);
  lr.remember(OHC, { url, openUrl: url, dir: "/tmp", port: 1, kind: "api", probeUrl: url, expect: "Healthy" });
  const [live] = await lr.status();
  assert.deepStrictEqual([live.project, live.state], [OHC, "up"]);
  await new Promise((resolve) => server.close(resolve));
  const [dead] = await lr.status();
  assert.strictEqual(dead.state, "starting"); // recién arrancado: aún no se da por caído
  lr.started.clear();

  /* ---------- plan completo sobre un árbol de mentira ---------- */

  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "monstro-run-"));
  fs.mkdirSync(path.join(tmp, "api", "openhealthcareapi"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "api", "openhealthcareapi", ".env"), "X=1");
  fs.mkdirSync(path.join(tmp, "launcher", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "dashboard"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "sinenv", "openhealthcareapi"), { recursive: true });

  const { items, plans, hostsLine } = await lr.buildPlan([
    { project: DASHBOARD, base: path.join(tmp, "dashboard"), branch: "development" },
    { project: LAUNCHER, base: path.join(tmp, "launcher"), branch: "feat/x" },
    { project: "OpenSaludGroup/opensalud", base: null, branch: null },
    { project: OHC, base: path.join(tmp, "api"), branch: "feat/y" },
  ], { detectRunning: false }); // sin mirar lo que ya corra en este Mac: el test no puede depender de eso
  const byProject = Object.fromEntries(items.map((i) => [i.project, i]));

  // Orden: APIs primero (los fronts necesitan sus puertos), lo no arrancable al final.
  assert.deepStrictEqual(items.map((i) => i.project), [OHC, LAUNCHER, DASHBOARD, "OpenSaludGroup/opensalud"]);

  // API: carpeta del csproj de arranque, puerto por defecto o el siguiente libre, y su .env encontrado.
  const api = byProject[OHC];
  assert.strictEqual(api.dir, path.join(tmp, "api", "openhealthcareapi"));
  assert.ok(api.port >= 44381 && api.port < 44401);
  assert.strictEqual(api.url, `https://localhost:${api.port}`);
  assert.strictEqual(api.openUrl, `${api.url}/swagger`);
  assert.ok(!api.needs.some((n) => n.code === "env-file"));
  assert.strictEqual(plans.get(OHC).probeUrl, `${api.url}/health`);
  assert.strictEqual(plans.get(OHC).expect, "Healthy");

  // El front apunta a la API del plan (y solo a esa: notifications no está).
  assert.deepStrictEqual(byProject[LAUNCHER].pointsTo, { api: api.url });
  assert.ok(plans.get(LAUNCHER).command.includes(`LOCAL_ENV_API='${api.url}'`));
  assert.ok(!plans.get(LAUNCHER).command.includes("LOCAL_ENV_NOTIFICATIONS"));
  assert.strictEqual(byProject[LAUNCHER].blocked, null);

  // Selector: Local por defecto con la URL exacta; eligiendo Dev el comando ya no lleva el override.
  assert.deepStrictEqual(
    byProject[LAUNCHER].targets.find((x) => x.key === "api"),
    { key: "api", apiProject: OHC, local: api.url, running: false, fallback: null, dev: "https://api-dev.openhealthcare.eu", choice: "local" },
  );
  const toDev = await lr.buildPlan([
    { project: OHC, base: path.join(tmp, "api"), branch: "feat/y" },
    { project: LAUNCHER, base: path.join(tmp, "launcher"), branch: "feat/x" },
  ], { detectRunning: false, targets: { [LAUNCHER]: { api: "dev" } } });
  assert.deepStrictEqual(toDev.items.find((i) => i.project === LAUNCHER).pointsTo, {});
  assert.ok(!toDev.plans.get(LAUNCHER).command.includes("LOCAL_ENV_API"));

  // API ya levantada fuera de este plan (otra sesión, tu clon): el front apunta a ella igual. Era el fallo.
  const other = http.createServer((_req, res) => res.end("Healthy"));
  await new Promise((resolve) => other.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const otherUrl = `http://127.0.0.1:${other.address().port}`;
  lr.remember(OHC, { url: otherUrl, openUrl: otherUrl, dir: "/tmp", port: other.address().port, kind: "api", probeUrl: `${otherUrl}/health`, expect: "Healthy" });
  const soloFront = await lr.buildPlan([{ project: LAUNCHER, base: path.join(tmp, "launcher"), branch: "feat/x" }]);
  const aimed = soloFront.items[0].targets.find((x) => x.key === "api");
  assert.deepStrictEqual([aimed.local, aimed.running, aimed.choice], [otherUrl, true, "local"]);
  assert.ok(soloFront.plans.get(LAUNCHER).command.includes(`LOCAL_ENV_API='${otherUrl}'`));
  // Con la API también en el plan manda la del plan, y la que ya corre queda de reserva por si la desmarcas.
  const both = await lr.buildPlan([
    { project: OHC, base: path.join(tmp, "api"), branch: "feat/y" },
    { project: LAUNCHER, base: path.join(tmp, "launcher"), branch: "feat/x" },
  ]);
  const withFallback = both.items.find((i) => i.project === LAUNCHER).targets.find((x) => x.key === "api");
  assert.deepStrictEqual([withFallback.local, withFallback.running, withFallback.fallback], [both.items.find((i) => i.project === OHC).url, false, otherUrl]);
  lr.started.clear();
  await new Promise((resolve) => other.close(resolve));

  // Sin node_modules no tiene sentido arrancar: bloquea ESE ítem, no el plan.
  assert.ok(byProject[DASHBOARD].needs.some((n) => n.code === "node-modules"));
  assert.deepStrictEqual(byProject[DASHBOARD].blocked, { code: "node-modules-missing" });
  // El dashboard no se puede redirigir: se dice a dónde va de verdad, sin selector.
  assert.deepStrictEqual(byProject[DASHBOARD].pointsTo, { api: "https://localhost:44381" });
  assert.deepStrictEqual(byProject[DASHBOARD].targets, []);
  assert.ok(byProject[DASHBOARD].warnings.some((w) => w.code === "dashboard-fixed-api"));

  // Fuera del catálogo: bloqueado con su motivo y sin nada que arrancar.
  const ouicare = byProject["OpenSaludGroup/opensalud"];
  assert.deepStrictEqual([ouicare.kind, ouicare.dir, ouicare.port], [null, null, null]);
  assert.deepStrictEqual(ouicare.blocked, { code: "windows-only", name: "Ouicare", iis: true });

  // Ni un solo texto para el usuario sale de main: todo son códigos con sus params.
  for (const item of items) {
    for (const x of [...item.needs, ...item.warnings, item.blocked].filter(Boolean)) {
      assert.strictEqual(typeof x, "object", `motivo sin código: ${JSON.stringify(x)}`);
      assert.ok(sampleCodes.has(x.code), `código desconocido en el plan: ${x.code}`);
    }
  }

  // El host del dashboard no está en /etc/hosts en este Mac → la línea exacta, sin tocar el fichero.
  const hostsNeed = byProject[DASHBOARD].needs.find((n) => n.code === "hosts-entry");
  if (hostsNeed) {
    assert.strictEqual(hostsNeed.host, "localdashboard.opensalud.es");
    assert.strictEqual(hostsLine, "127.0.0.1 localdashboard.opensalud.es");
  }

  // Sin .env (lo que pasa en un worktree recién creado: va en .gitignore) → bloqueado y sin override
  // que apunte a él.
  const sinEnv = await lr.buildPlan([
    { project: OHC, base: path.join(tmp, "sinenv"), branch: "feat/y", newWorktree: true },
    { project: LAUNCHER, base: path.join(tmp, "launcher"), branch: "feat/x" },
    { project: DASHBOARD, base: path.join(tmp, "dashboard"), branch: "feat/z", newWorktree: true },
  ], { detectRunning: false });
  const roto = sinEnv.items.find((i) => i.project === OHC);
  assert.deepStrictEqual(roto.needs.find((n) => n.code === "env-file"), { code: "env-file", file: "openhealthcareapi/.env" });
  assert.deepStrictEqual(roto.blocked, { code: "env-missing", file: "openhealthcareapi/.env" });
  // El aviso del worktree lleva la rama y el fichero a copiar: el renderer solo pone la frase.
  assert.deepStrictEqual(
    roto.warnings.find((w) => w.code === "new-worktree-env"),
    { code: "new-worktree-env", branch: "feat/y", file: "openhealthcareapi/.env" },
  );
  assert.deepStrictEqual(sinEnv.items.find((i) => i.project === LAUNCHER).pointsTo, {});

  // Un front en worktree nuevo avisa de lo otro que va en .gitignore: node_modules.
  const front = sinEnv.items.find((i) => i.project === DASHBOARD);
  assert.deepStrictEqual(front.blocked, { code: "node-modules-worktree" });
  assert.deepStrictEqual(
    front.warnings.find((w) => w.code === "new-worktree-modules"),
    { code: "new-worktree-modules", branch: "feat/z" },
  );

  // Con el .env en tu clon la cosa no es problema tuyo: no bloquea, avisa de que lo copia, y copyLocalFiles
  // lo trae al worktree conservando permisos, sin pisar lo que ya hubiera y solo del clon hacia fuera.
  const clon = path.join(tmp, "clon");
  const wt = path.join(clon, ".worktrees", "feat-y");
  const envRel = "openhealthcareapi/.env";
  fs.mkdirSync(path.join(clon, "openhealthcareapi"), { recursive: true });
  fs.mkdirSync(path.join(wt, "openhealthcareapi"), { recursive: true });
  fs.writeFileSync(path.join(clon, envRel), "AWS__SECRETS_MANAGER__ACCESS_KEY=x\n", { mode: 0o600 });
  const conClon = await lr.buildPlan([{ project: OHC, base: wt, clone: clon, branch: "feat/y", newWorktree: true }]);
  const traible = conClon.items.find((i) => i.project === OHC);
  assert.notStrictEqual(traible.blocked?.code, "env-missing", "si el .env está en el clon no debe bloquear");
  assert.ok(!traible.needs.some((n) => n.code === "env-file"));
  assert.deepStrictEqual(traible.warnings.find((w) => w.code === "env-copy"), { code: "env-copy", file: envRel });
  assert.deepStrictEqual(
    traible.warnings.find((w) => w.code === "new-worktree-env-copy"),
    { code: "new-worktree-env-copy", branch: "feat/y", file: envRel },
  );
  assert.deepStrictEqual(lr.copyLocalFiles({ project: OHC, base: wt, clone: clon }), [envRel]);
  assert.strictEqual(fs.readFileSync(path.join(wt, envRel), "utf8"), "AWS__SECRETS_MANAGER__ACCESS_KEY=x\n");
  assert.strictEqual(fs.statSync(path.join(wt, envRel)).mode & 0o777, 0o600, "el .env copiado conserva sus permisos");
  fs.writeFileSync(path.join(wt, envRel), "EL_MIO=1\n");
  assert.deepStrictEqual(lr.copyLocalFiles({ project: OHC, base: wt, clone: clon }), [], "no se vuelve a copiar");
  assert.strictEqual(fs.readFileSync(path.join(wt, envRel), "utf8"), "EL_MIO=1\n", "nunca pisa el fichero del worktree");
  assert.deepStrictEqual(lr.copyLocalFiles({ project: OHC, base: clon, clone: clon }), [], "en el propio clon no hay nada que copiar");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("test-local-run OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
