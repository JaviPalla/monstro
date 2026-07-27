# Milestone summary (Resumen)

`renderer/app/milestones-summary.js`. AI-generated "novedades" list.

**Source of truth = localStorage** (`pulpo:ms-summary:<title>`, kept under the legacy prefix on purpose) — it holds the per-item `included`/order/edited headline and is only overwritten by **Regenerar**.

GitLab gets a **mirror, never a source**: `syncSummaryToMilestone` writes the markdown (+ the snippet link once published) into the **group milestone's description** via `saveMilestoneSummary({milestoneTitle, contentMarkdown})`, inside `<!-- monstro:summary:start/end -->` markers so `mergeSummaryBlock` replaces only its own block and preserves anything a human wrote around it (check: `node scripts/test-summary-block.js`).

It fires **automatically after generating** (user's explicit choice — the one place in the app that writes remotely without a confirm modal; skipped under selftest) and again on **Publicar enlace en GitLab**, so the milestone ends up with the edited content + the snippet URL. A failed mirror is a toast only, never loses the local summary.

The backend resolves the milestone **by title** (renderer sends no ids) and PUTs to `found.group_id`, **not** the configured group: with `include_ancestors=true` the milestone may live in a parent group and a PUT to the child 404s. GitHub stub throws.
