# Milestones view — tareas por persona

GitLab-only, `state.view==="milestones"`, `renderer/app/milestones.js`.
The "Resumen" tab lives in `docs/arch/summary.md`.

A top-level view (like history) showing a **group** milestone's issues grouped by **assignee** (an issue with N assignees shows under each; unassigned → "Sin asignar", sorted last). Group = `config.milestones.group` or derived from `repos[0]`'s first path segment.

**GOTCHA: the GitLab issues API param is `milestone=<title>`, NOT `milestone_title=` — the wrong one is silently ignored and returns the whole group's issues.**

## Fetch

The fetch **always pulls `state=all`** for the selected milestone (closed included) because the metrics are computed against closed/finished issues; "Mostrar cerradas" and "Mostrar sin asignar" are **display-only filters** (closed and unassigned hidden by default), no refetch. Bounded by milestone, but `apiAll`'s 5-page/500 cap can still under-count metrics on a huge milestone.

Default milestone = the date-current one (`pickCurrentMilestone`: skip future/past by `start_date`/`due_date`, prefer the one containing today).

## Status filter chips (tri-state)

`statusLabels` render as **tri-state filter chips** (`filters.status` is a `Map<label,"include"|"exclude">`: neutral → include-only → exclude/hide → neutral) **colored with the label's real GitLab color** (looked up in `m.labels`): neutral = border-only, include = filled bg + green ✓, exclude = border-only + red ✕ + struck text; `doneLabels` (`finished` + the `pending check*` variants = "terminada pero no cerrada") are **seeded as `exclude`** so they start hidden.

Status chip text uses `readableText(hex)` (rec.601 luminance → black/white) for the filled state and `var(--text)` for unfilled, so the label is legible whatever the GitLab color.

No "Estado:" label — instead an **info icon pinned to the top-right of `.ms-filters`** (`statusFilterHelp`) whose hover/focus popover animates the three filter states (sin filtro → solo estas → ocultas); popover inherits the app font and opens right-aligned.

Status chips + the two display toggles (Mostrar cerradas / sin asignar) + counter + refresh live inside one `.ms-filters` block.

## Metrics

**Two metrics** (milestone-level header + per-assignee), always computed over the FULL set of **assigned** issues (not the filtered view, so hiding a label never zeroes its %), with categories closed `C`, open-`finished` `F`, open-`pending check*` `P`, open-rest (to do) `T` and base `C+F`. They are **completion** ratios (how much is done, not what's left):

- **Terminadas** = `(C+F)/(C+F+T)`
- **Comprobadas** = `(C+F)/(C+F+P)`

(both ≤100%). `splitDoneLabels` separates `pending check*` from `finished` by name.

Both the **current milestone's rail tab** (under the name, left of `vence`, via `showCount`) and each per-assignee header render the two indicators as compact `metricChips` (`✓` Terminadas green / `◉` Comprobadas accent); per-assignee ones show only `%` (n/m in tooltip). No separate summary block, no bars, no due-date prose, no "asignadas" count.

## Layout & motion

The board grid is `repeat(auto-fill, minmax(320px, 460px))`: columns widen to ~460 (full name + chips) then auto-fill adds more. The two display toggles and the per-issue selection use **custom round checkboxes** (`appearance:none` on the real inputs, accent fill + ticked-scale animation). Columns/tasks have CSS **entrance animations** (`ms-col-in`/`ms-task-in`, staggered) that retrigger on every `renderMilestones` (load + filter changes), plus a `loading-pulse`; all gated behind `prefers-reduced-motion: no-preference`.

Descriptions are GitLab markdown → escaped via `mdToSafeHtml` (never inject unescaped).

## Mutations

Multi-select (per-issue checkbox) drives bulk **label** edits (modal of all group labels as real-color badges: border-only = absent, filled = present; apply diffs vs the labels all selected already share) and **milestone** moves; **drag&drop** reassigns issues between people (move: drop-source assignee removed, target added, co-assignees kept) or onto the right-hand milestone rail to move milestone. Issue mutations go through `gitlab.updateIssue(projectId, iid, patch)` / `groupLabels()` (GitHub stubs throw); applied **sequentially, non-atomically** then a full refetch.

## Nav

The view has **two nav items** under the MILESTONES sidebar section (`#bucket-milestones` "Tareas por persona" + `#bucket-milestones-summary` "Resumen"), both entering the same view via `enterMilestones(tab)` which sets `state.milestones.tab` `"tasks"`/`"summary"` and lights the matching bucket; `renderMilestones` renders the shared milestone rail + either the task board or `milestoneSummaryHtml()`. NOT tabs inside the view (user preference, same as Releases).
