# Environments view (Entornos)

GitLab-only, `state.view==="environments"`, `renderer/app/environments.js`.

A top-level view showing a **project × environment matrix** with the health of every deployed
environment. **Two independent layers per cell, and neither replaces the other**:

## Layer 1 — deployment state (GitLab, always)

`projectEnvironments(projectId)` returns each environment with its LAST deployment.

**GOTCHA (verified against the live instance): `GET /projects/:id/environments` does NOT return `last_deployment`** — only the single-environment detail does. So instead of N detail calls it issues one `/deployments?environment=<name>&order_by=created_at&sort=desc&per_page=5` per environment, which costs the same AND lets it skip the `skipped` noise (feature branches that trigger the deploy job without deploying).

Cost = **1 + M calls per project** (M = environments), M in parallel; projects run through a fixed **pool of 4** (`ENV_CONCURRENCY`) — on-demand refresh only, **never on the poll**.

Cell verdict (`deployVerdict`): failed/canceled → red, running/created/blocked → accent, success older than `staleDays` (default 45) → **stale/amber**, else green.

Columns = union of all environment names, sorted by `tier` (`TIER_RANK`: development < testing < staging < production < other) so the matrix reads left-to-right by how close to prod it is; this also exposes **drift** (prod three releases behind staging) at a glance.

## Layer 2 — HTTP probe (only if the environment has `external_url`)

Lives in **main.js (`env:health`)**, not the renderer: the renderer is sandboxed and the CSP forbids external hosts. The verdict is a pure function in **`src/health.js` (`healthVerdict`)** with **THREE states on purpose**.

**A 2xx is NOT proof of health**: a SPA serves index.html with 200 on ANY path (verified: `dashboard.opensalud.es` returns 200 `text/html` on `/health`, `/status` AND `/esto-no-existe`). So 200-with-HTML and no configured `expect` string is **`unknown` (amber), never `up`** — a health check that lies is worse than none. `up` needs positive proof: a non-HTML response (an API returning JSON) or the configured `expect` text present in the body.

Check: `node scripts/test-health-verdict.js`.

## Do not reach for these

**GitLab `/-/health`, `/-/readiness`, `/-/liveness` are USELESS here** — they monitor the GitLab instance itself (and need an IP allowlist), not the apps deployed through it.

## Config & seeding

Config `environments` = `{selectedProjects[]|null, healthPaths{}, healthExpect{}, staleDays}`. `healthPaths`/`healthExpect` are keyed by project path and read **from config in main, never from the renderer** (the renderer only sends the url + project).

Seeding: saved `selectedProjects` else `releases.defaultProjectIds` — deliberately **not** `releases.selectedProjects` (that is "whatever was published last", often a single project). The project picker is a native `<details>` (the group has ~40 projects and the full chip bar buried the matrix).

## Caveat

**`external_url` is only populated if the CI declares `environment: {name, url:}`** — on this instance only 2 of the 8 release projects do, so most rows show layer 1 only. Fixing that lives in each project's `.gitlab-ci.yml`, not here.

Selftest route `--selftest-route=entornos` (60s); it waits for the FULL matrix (every selected project in `e.data` and no probe in flight) before capturing. GitHub stub `projectEnvironments` throws for parity.
