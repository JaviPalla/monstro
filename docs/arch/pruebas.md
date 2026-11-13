# Pruebas — las tareas por probar y su pipeline (solo GitLab)

`state.view === "pruebas"`, `renderer/app/pruebas.js` + `css/pruebas.css`. Main: `src/gitlab/pruebas.js` (red),
`src/pruebas-rules.js` (reglas PURAS, sin red: `node scripts/test-pruebas.js`), IPC `pruebas:board` /
`pruebas:task` / `pruebas:act` / `pruebas:newPipeline` / `pruebas:runMrPipeline` (`src/ipc/pruebas.js`). La vista se prueba con un arnés `vm`
(`node scripts/test-pruebas-view.js`, como `test-palette.js`). Spec:
`docs/superpowers/specs/2026-11-12-pruebas-tareas-design.md`.

Es la vista de quien **prueba**: lo que el bot de delivery-flow enlaza en el comentario de la epic (el pipeline
`Epic #N` del proyecto `epics`, id 62) más el pipeline de cada MR, sin ir a buscar la epic a GitLab. Revisar el
código es otra sección (Merge requests). «Validación» (tablero por columnas) es otra cosa y sigue con los nombres
de job de delivery-flow 2.0.

**Se activa en Ajustes → Apartados** como cualquier sección nueva: quien ya eligió apartados (`config.sections` es un
array) no la ve hasta marcarla. Está en el preset «desarrollo».

## Qué entra

Cuatro orígenes, todos de los proyectos que lleva el flujo (`FLOW_PROJECTS`, copia de `ENABLED_PROJECTS` de delivery-flow):
epics con `pending check` / `checking` / `needs fixing`; issues locales con esas etiquetas; MRs con esas etiquetas;
hotfix (MR abierta a `development` con rama `hotfix/*` o etiqueta `sin-dev`). Una MR que ya está en la tarjeta de una
epic o issue no se repite. Quedan fuera: tareas hijas por jerarquía, tareas de varios proyectos sin epic y epics con
`pending check in pruebas`. Una issue local con la etiqueta cuyas MRs ya están mergeadas sale como «Sin MRs abiertas».

Coste de una carga completa: 3 llamadas de issues + ⌈MRs/100⌉ de MRs de grupo, 1 de etiquetas del grupo, 1
`related_merge_requests` por epic y, por tarjeta, el pipeline de la epic (`pipelines?name=Epic #N`) y el detalle + jobs
de cada MR.

## Tiempo real

GitLab no empuja eventos a una app con token personal, así que se sondea (`startPruPoll`, arranca al entrar y se da de
baja solo al salir de la vista). Un único temporizador de 10 s:
- **Cada tick** recarga solo las tarjetas con `detail.live` (algún job `running`/`pending`/`preparing`/
  `waiting_for_resource`/`scheduled`; lo calcula `summarize`). `created` NO cuenta: los jobs de fases posteriores
  esperan siempre en `created`. Un job en `manual` tampoco: espera a una persona.
- **Cada `pollSeconds` (60 s)** recarga la lista entera en silencio (tareas nuevas, etiquetas, lo que alguien haga
  desde GitLab).
- En silencio no hay «Cargando», ni parciales, ni avisos de error (si falla, se queda lo que había y el siguiente tick
  reintenta), y si la respuesta es idéntica no se repinta. Con la ventana oculta (`document.hidden`) o durante una
  carga visible no se sondea; una recarga lenta no se apila (`pruRefreshing`, `pruSilentRun`) y «Recargar» manual gana a
  una silenciosa en vuelo (`pruRun`).
- Los «otros jobs» abiertos siguen abiertos entre repintados (`pruOpen`).

## Filtro por etiqueta

Cada tarea lleva todas las etiquetas de su epic, issue o MR (`task.labels`; `task.label` sigue siendo solo la de ciclo).
Encima de los grupos hay un chip por **cada etiqueta del grupo** (`GET groups/:g/labels`, que los proyectos heredan: 44
el 13-nov), con cuántas tareas la llevan; las de 0 salen atenuadas, para que un compañero con su `QA: nombre` sin
tareas todavía pueda filtrar. Elegir varios deja las tareas que las llevan **todas** (como GitLab). Las `QA: nombre`
(`pruIsQa`: sin distinguir mayúsculas ni espacios antes de los dos puntos) van primero y destacadas: es la etiqueta que
pone quien se lleva una tarea a probar; luego las que tienen tareas y al final las de 0. «QA: alejandro» y
«QA: alejandro.perez» son personas distintas y salen como chips distintos, sin normalizar. La selección se guarda en
`localStorage` (`monstro:pruebas-labels`); una etiqueta elegida que ya no existe sigue visible en la barra para poder
quitarla. Si falla la petición de etiquetas del grupo, la barra sale solo de las tareas y se avisa con un error
«Etiquetas: …».

## Qué hace cada botón

El main decora cada job (`decorateJob`): `manual` → ▶ (`play`), `failed`/`canceled` → ↻ (`retry`), nada en un
pipeline cancelado. `mergear-tarea` y `devolver-tarea` piden confirmación (devolver admite `MOTIVO`, solo en ▶);
`validar-tarea-para-mergear` la pide si `probar-tarea-en-desarrollo` no está en éxito («Validar sin dev»).
Crear un pipeline vive **dentro de cada tarea** (no hay botón global):
- **Epic** → «Nuevo pipeline» en la cabecera del bloque de la epic, siempre visible: `POST projects/62/pipeline` con
  `EPIC_IID` (como el bot); no duplica una ronda sin terminar (el aviso enlaza la vigente). Recarga solo esa tarjeta.
- **Tarea sin epic u hotfix** → «Run pipeline» en cada MR: `POST projects/:id/merge_requests/:iid/pipelines`, lo mismo
  que el botón de la pestaña Pipelines de la MR en GitLab (pipeline de merge request; el proyecto debe tener reglas
  `merge_request_event` en su CI). Las MRs de una epic no lo llevan: las gobierna el pipeline de la epic. Canal IPC
  `pruebas:runMrPipeline`, validado con `parseMrRef` (proyecto del flujo + iid entero positivo).

Un doble clic manda una sola petición, en los jobs y en los dos botones de pipeline (`state.pruebas.busy`; las rondas que
crea una persona no las cancela el bot, así que dos clics dejarían dos `Epic #N`). «Sin terminar» = manual, en marcha o
en cola (`isOpenPipeline`: el `resource_group` de la epic puede dejarlo en `waiting_for_resource`).
Un `validar-tarea` fallido se muestra como «La validación falló» aunque `mergear-tarea` quede en manual
(`validar-tarea` es `allow_failure`).

## GOTCHAS

- **`probar-tarea` se niega en stderr, no en el estado.** El motivo («dev ocupado por !1043») está en la traza del
  job: líneas `<fecha> 01E …` (`E` = stderr). `traceReason` las extrae, sin ANSI, ≤ 15 líneas, y solo para jobs fallidos
  del flujo.
- **`GET merge_requests` (lista) NO trae `head_pipeline`**: hay que pedir cada MR. `related_merge_requests` de una epic
  incluye menciones incidentales: solo cuentan las MRs que citan `epics#N` o su URL.
- **La lista de pipelines trae `name`** (`Epic #303`) y admite filtrarlo; el primero es la ronda vigente (el bot cancela
  las anteriores).
- **Un hotfix NO tiene job propio** (`validar-sin-dev` solo existe en un borrador): lleva los jobs normales y la urgencia
  es ▶ `validar-tarea-para-mergear` directo (solo Maintainer).
- **Deriva con delivery-flow:** nombres de job y proyectos están replicados en `src/pruebas-rules.js`. Si el flujo los
  cambia, cambian aquí.
- Una epic **sin etiqueta de ciclo** no sale en la lista, así que tampoco tiene su «Nuevo pipeline»: se crea desde GitLab
  (o poniéndole `pending check`).
- **Tests del renderer con `vm`:** los objetos que crea el script viven en otro realm; `deepStrictEqual` falla por
  prototipos, se compara por JSON. Y una promesa sin resolver deja Node salir con 0: el runner exige completar.

Selftest `--selftest-route=pruebas` (60 s, datos reales).
