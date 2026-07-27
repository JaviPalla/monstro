# Releases view

GitLab-only, `state.view==="releases"`, `renderer/app/releases.js` +
`releases-publish.js` + `releases-pipelines.js`.

Two nav items under the RELEASES sidebar section (`#bucket-releases` "Ramas" +
`#bucket-releases-publish` "Publicar"), both entering the same view via `enterReleases(tab)`
which sets `state.releases.tab` `"branches"`/`"publish"` (shared project picker/`selected`) and
lights the matching bucket; `renderReleases` dispatches to the branch form or
`renderReleasePublish`. NOT tabs inside the view (user preference).

**Repo-agnostic** (group-scoped): switching the repo selector doesn't touch it. Both buckets are
hidden when `provider!=="gitlab"`; both have ⌘K palette entries.

---

## Ramas (branch generation)

A top-level view (like history/milestones) that **generates release branches** `${branchPrefix}<version>` (default `rb/`) across projects — replicates the legacy `auto-rb-branches.py` (issue OPE-18).

The selectable **projects are pulled live from the group** via `groupProjects()` (reusing the milestone-summary project data + icons; non-archived), **not** a hardcoded list (the old hardcoded 8 went stale/missing projects).

Config `releases` = `{sourceBranch (default "development"), branchPrefix (default "rb/"), defaultProjectIds[] (the script's 8, by **numeric id** — names drifted, ids are stable), selectedProjects[]|null (last user selection, by path — remembered across sessions), ouicare:{projectPath, webConfigPath, appDateKey}}`.

UI: version input **prefilled with `MMYYYY` of the current month** (`suggestedReleaseVersion`, e.g. `062026`), live `rb/…` preview + `BRANCH_RE` validation; source-branch input (default `development`); **project picker = `.ms-proj-chip` chips** (same design as the summary's per-project filter — icon + name, `.off`/struck = deselected), click toggles, "Todos/Ninguno" button.

**Selection seeding** (`r.seeded`, once per session): restore `selectedProjects` (paths still in the group) if saved, else seed from `defaultProjectIds` (match group projects by id → their paths); every toggle persists via `setConfig({releases:{selectedProjects}})` (no-op under selftest).

**Ouicare AppDate**: `AppDate` is an appSetting in Ouicare's `Web.config` (cache-buster feeding the appcache "App Markup Date") that must bump each release — when Ouicare (`ouicare.projectPath`) is among the selected, a panel shows a **native `<input type=date>` defaulting to today**; on generate, `updateOuicareAppDate` GETs the file, regex-replaces the `AppDate` value (format **DDMMYYYY**), and commits it to the **source branch before** branching (skips the commit if unchanged — GitLab rejects empty commits).

**Never auto-fires**: a confirm modal lists branch + source + target projects + the AppDate change. `generateReleaseBranches({projects,version,sourceBranch,ouicare})` POSTs `repository/branches {branch,ref}` per project, **sequentially and non-atomically** (one failure doesn't stop the rest), returning `{branch, ref, appDate, results:[{id,name,ok,error?,webUrl?}]}`; renderer shows the AppDate result + ✓/✕ per project.

**Security**: the legacy script hardcoded a GitLab token — **never replicate that**; the token resolves through `resolveToken`. `releases:generate` validates project-id **format** (path or numeric) and relies on the token's GitLab write perms as the real boundary (ponytail: no group re-fetch just to validate — `groupProjects` proxies avatars = costly); Ouicare's `projectPath`/`webConfigPath`/`appDateKey` come from **config, not the renderer** (renderer sends only `enabled`+`date`, validated `^\d{8}$`). GitHub side: throwing stubs (`releaseDefaults`/`generateReleaseBranches`) for parity.

Selftest route `--selftest-route=releases` (60s timeout — `groupProjects` avatar-proxying is slow).

---

## Publicar (tag + release)

`tab==="publish"`, `state.releases.publish`. Creates the actual **tag + release** in N projects from an `rb/…` branch. GitLab's `POST /projects/:id/releases {tag_name, ref, milestones[], description, name}` **creates the tag if absent → tag+release in ONE call** (kills the old manual two-step).

**Versioning = CalVer derived from the rb branch**: `calverBase("rb/062026") → "2026.06"` (regex `(\d{2})(\d{4})$`; fallback = current month). The patch auto-increments **per project**: `nextReleaseTag(projectId, base)` lists `/releases`, finds tags `^<base>\.(\d+)$`, returns `<base>.<max+1>` (numeric, not lexical — `.10 > .2`), else `.0`. So one logical "group release" fans out to per-project `2026.06.<patch>` tags (GitLab has **no native group release**).

**Milestone** (optional, lazy-loaded `listMilestones()` titles → `milestones:[title]`; group milestone titles are accepted by the release API). Optional Markdown `description`; release `name` defaults to the tag (`"{tag}"` template). `createReleases({projects,ref,base,milestones,description,name})` loops **sequentially/non-atomically**, returns `{base,ref,milestones,results:[{id,name,ok,tag,releaseUrl?,error?}]}`.

**Status panel**: after publishing, `startReleaseStatusPoll` calls `releaseStatus(projectId, tag)` per OK project (pipeline via `/pipelines?ref=<tag>` → `mapPipeline`; environments via `/environments`), polling every `pollSeconds` and **stopping when all pipelines hit a terminal state SUCCESS/FAILURE/ERROR or after ~20 ticks** (avoids endless polling when a project has no tag CI); a pipeline transitioning to FAILURE/ERROR fires **toast + OS `notify`** ONCE (detectAndNotify pattern), skipped under selftest.

**Deploy pipelines tab** (`releasePipeline(projectId, ref)` → `releases-pipelines.js`): with an explicit `ref` the caller wins (you picked that release in the selector). **Without one it does NOT just take the newest release** — dashboard's CI publishes a release-cli tag (`rb/072026/<timestamp>`) on every push to `rb/*`, and those never trigger a pipeline, so the newest release is permanently pipeline-less and the tab was stuck on "esta release no tiene pipeline". It walks the **first 5** releases via `pipelineFor()` until one has a pipeline. A failing tag returns null rather than throwing, so the loop just moves on.

**Validation** (`releases:create`/`releases:status`): `base` `^\d{4}\.\d{2}$`, `ref`/tag `BRANCH_RE`, project ids path-or-numeric, milestone titles sanitized; token perms are the real write boundary. GitHub stubs (`nextReleaseTag`/`createReleases`/`releaseStatus`) throw for parity.

Selftest route `--selftest-route=releases-publish` (60s, calls `enterReleases("publish")`).
