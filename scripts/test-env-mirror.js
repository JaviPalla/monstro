"use strict";
/**
 * Guarda de los entornos espejo: mirrored() en renderer/app/environments.js.
 *
 * Un espejo copia el despliegue de OTRA columna (config `environments.mirrors`), y eso solo es
 * honesto mientras el destino no despliegue por su cuenta. Lo que se protege aquí es justo eso: que
 * el espejo se APAGUE SOLO en cuanto el entorno destino reciba su primer despliegue propio. Si esa
 * condición se rompe, la matriz seguiría mostrando el tag del vecino tapando el despliegue real —
 * mentir sobre qué versión hay en un entorno es el peor fallo posible de esta vista.
 *
 * Se ejecuta con `node scripts/test-env-mirror.js`. Mismo truco que test-palette.js: el renderer son
 * scripts clásicos en ámbito global, así que se evalúa el fichero en un contexto vm.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "environments.js"), "utf8");
const context = vm.createContext({ state: { config: {} }, t: (es) => es, esc: (s) => s });
vm.runInContext(SOURCE, context);
const { mirrored } = context;

const withDeploy = (name, ref) => ({ name, deployment: { ref, status: "success" } });
const empty = (name) => ({ name, deployment: null });

// Caso real: staging-mx no despliega nada y sirve el mismo bundle que staging → hereda y se marca.
{
  const envs = [withDeploy("staging", "rb/072026"), empty("staging-mx")];
  const out = mirrored(envs[1], envs, "staging");
  assert.strictEqual(out.deployment.ref, "rb/072026");
  assert.strictEqual(out.mirrorOf, "staging");
  assert.strictEqual(out.name, "staging-mx", "el espejo no debe reescribir el nombre del entorno");
}

// LO IMPORTANTE: el día que alguien añada el job de deploy a staging-mx, manda su despliegue.
{
  const envs = [withDeploy("staging", "rb/072026"), withDeploy("staging-mx", "rb/072026-mx")];
  const out = mirrored(envs[1], envs, "staging");
  assert.strictEqual(out.deployment.ref, "rb/072026-mx");
  assert.ok(!out.mirrorOf, "con despliegue propio no puede quedar marcado como espejo");
}

// Origen también vacío (o inexistente): no hay nada que copiar, la celda se queda vacía de verdad.
assert.strictEqual(mirrored(empty("staging-mx"), [empty("staging"), empty("staging-mx")], "staging").deployment, null);
assert.strictEqual(mirrored(empty("staging-mx"), [empty("staging-mx")], "staging").deployment, null);

// Sin entrada en `mirrors` el entorno pasa intacto: el espejo es opt-in por proyecto, nunca implícito.
{
  const env = empty("staging-mx");
  assert.strictEqual(mirrored(env, [withDeploy("staging", "rb/072026"), env], undefined), env);
}

console.log("test-env-mirror: OK");
