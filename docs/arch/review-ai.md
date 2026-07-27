# Review drafts + AI review

Read this when touching `src/drafts.js`, `src/ai.js`, `renderer/app/drafts.js` or the review
publishing flow.

- **Review drafts**: comments (inline + general) are saved locally via `src/drafts.js` and only published when the user clicks Publicar — ONE review (POST /pulls/N/reviews) with verdict COMMENT/APPROVE/REQUEST_CHANGES. Never auto-publish.
- **AI review** (`src/ai.js`): generates English review comments from the PR diff as DRAFTS only (ai:true, purple cards) — never publishes. Backend order: `ANTHROPIC_API_KEY` → official Anthropic SDK (structured outputs via `output_config.format`) → fallback to the user's authenticated Claude Code CLI (`claude -p --output-format json --model … [--effort …]`, parse `.result`). Model and effort are user-configurable in Settings (catalog in `AI_MODELS`, defaults `claude-opus-4-8` / `high`; Haiku gets no effort/thinking params). Every AI draft is tagged with `aiModel`/`aiEffort` and the card shows them. Anchors are validated against commentable diff lines in the renderer; unanchorable comments fold into the general summary draft.

Note: on GitLab `submitReview` is **not atomic** — see `docs/arch/provider.md`.

## Notifications

`detectAndNotify`: first poll never notifies; only state *changes* do. Dock badge = PRs awaiting
my review.
