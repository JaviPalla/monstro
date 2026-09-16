# Review drafts + AI review

Read this when touching `src/drafts.js`, `renderer/app/drafts.js`, `renderer/app/actions.js` or the
review publishing flow.

- **Review drafts**: comments (inline + general) are saved locally via `src/drafts.js` and only published when the user clicks Publicar — ONE review (POST /pulls/N/reviews) with verdict COMMENT/APPROVE/REQUEST_CHANGES. Never auto-publish.
- **"Review con IA" button** (`renderer/app/actions.js` → `launchAiReview`): does NOT run in-app. It's the exact same launcher Agents uses for a session's MR (`docs/arch/sessions.md` → Launcher) — `window.monstro.sessionsLaunch(pr.url, "review")` resolves the MR's local clone and opens an **interactive** `claude` session in a new Ghostty tab running `/mr-review-gitlab <url>`. The skill runs with your own permissions (no `bypassPermissions`) and publishes its findings as GitLab **draft notes** (not Monstro's local `drafts.js` store) — still nothing goes out until you publish them from the ficha or from Monstro. There used to be an in-app engine here (`src/ai.js` → `generateReview`, a deep-mode worktree, a live progress modal); it was removed when the button switched to the terminal launcher — don't resurrect it piecemeal, the whole point was one launcher shared with Agents instead of two different review paths.
  - GitLab-only, like the rest of the launcher: a GitHub install has no equivalent skill to run.
  - Mirrored in the ⌘P palette (`renderer/app/palette.js`, "Review con IA" entry) — same call, same button-disabled guard.
- **Priority bubbles**: every comment carries a `severity` (`blocker` 🔴 · `important` 🟠 · `minor` 🟡 · `nit` 🟢, default `minor`). The map lives in `renderer/app/drafts.js` (`SEVERITIES`) and drives the coloured pill, the `.sev-*` CSS, the ↑↓ ordering (worst first) and the manual composer's picker. `publishBody()` prefixes the emoji + label to the body when publishing, so the priority survives into GitLab, which does not render our CSS.
- **Review before it lands**: the drafts viewer lists exactly what would be published; each row is editable in place (body + priority) without leaving the modal. Selftest routes `review` / `review-edit` seed a few manual severities and screenshot it.

Note: on GitLab `submitReview` is **not atomic** — see `docs/arch/provider.md`.

## Notifications

`detectAndNotify`: first poll never notifies; only state *changes* do. Dock badge = PRs awaiting
my review **+ Agents sessions waiting for you** (`setDockBadge(part, n)` in core.js sums both parts; see docs/arch/sessions.md).
