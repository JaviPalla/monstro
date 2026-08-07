# Review drafts + AI review

Read this when touching `src/drafts.js`, `src/ai.js`, `renderer/app/drafts.js` or the review
publishing flow.

- **Review drafts**: comments (inline + general) are saved locally via `src/drafts.js` and only published when the user clicks Publicar — ONE review (POST /pulls/N/reviews) with verdict COMMENT/APPROVE/REQUEST_CHANGES. Never auto-publish.
- **AI review** (`src/ai.js` → `generateReview`): mirrors the `mr-review-gitlab` skill's strategy — verify every finding against the real code, comments in Spanish, concise, jargon-free, step-by-step scenario for the serious ones, 3-10 comments max. Produces DRAFTS only (ai:true, purple cards) — never publishes.
  - **Deep mode** (default when the repo is cloned locally): `src/ipc/prs.js` resolves the clone under `config.local.rootDir` by `gitlabPath`, and the CLI runs with `cwd` = that repo so the agent opens files and follows callers instead of guessing from the diff. **Read-only is enforced via `--settings` `permissions.deny` (`DENIED_TOOLS`), not `--disallowedTools`** — verified: the CLI inherits the target repo's own `.claude/settings*.json` and a `--disallowedTools`-only run still managed to create a file. `Bash` is denied too (Read/Grep/Glob are enough to follow callers, and no shell means no back door to writes). Timeout is `REVIEW_TIMEOUT_MS` (25 min), not the 12 min of one-shot calls.
  - **Fallback** (no local clone): the same prompt as a one-shot, told explicitly it can only see the diff and must not assert what it cannot check. Backend order stays `ANTHROPIC_API_KEY` → Anthropic SDK → Claude Code CLI.
  - Model and effort are user-configurable in Settings (catalog in `AI_MODELS`, defaults `claude-opus-4-8` / `high`; Haiku gets no effort/thinking params). Every AI draft is tagged with `aiModel`/`aiEffort` and the card shows them. Anchors are validated against commentable diff lines in the renderer; unanchorable comments fold into the general summary draft.
- **Priority bubbles**: every comment carries a `severity` (`blocker` 🔴 · `important` 🟠 · `minor` 🟡 · `nit` 🟢, default `minor`). The map lives in `renderer/app/drafts.js` (`SEVERITIES`) and drives the coloured pill, the `.sev-*` CSS, the ↑↓ ordering (worst first) and the manual composer's picker. `publishBody()` prefixes the emoji + label to the body when publishing, so the priority survives into GitLab, which does not render our CSS.
- **Review before it lands**: after generating, the drafts viewer opens by itself listing exactly what would be published; each row is editable in place (body + priority) without leaving the modal. Selftest routes `review` / `review-edit` seed the four severities and screenshot it.

Note: on GitLab `submitReview` is **not atomic** — see `docs/arch/provider.md`.

## Notifications

`detectAndNotify`: first poll never notifies; only state *changes* do. Dock badge = PRs awaiting
my review.
