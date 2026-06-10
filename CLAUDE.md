# CLAUDE.md — Pulpo

Mac (Electron) GitHub PR client for Jesús. Bitbucket-style PR list + detail pane.

## Hard rules (product decisions, never change without being asked)
- Update branch = **rebase** (`updatePullRequestBranch` with `updateMethod: REBASE`).
- Merge = **merge commit** (`merge_method: "merge"`). **Squash must never be offered or implemented.**
- The token is never hardcoded, committed, or sent to the renderer. Resolution: `GITHUB_TOKEN` env → `gh auth token` → manual token in userData config (0600).

## Stack & layout
- Electron (no bundler, no framework): vanilla JS renderer.
- `src/main.js` — window, IPC handlers, `--selftest` (screenshot to /tmp/pulpo-selftest.png then quit).
- `src/github.js` — GraphQL (list/detail/update-branch) + REST (merge, delete ref). All GitHub calls live in the main process.
- `src/config.js` — config.json in `app.getPath("userData")` (repos[], pollSeconds, optional manual token).
- `src/preload.js` — contextBridge API (`window.pulpo.*`); renderer is sandboxed, contextIsolation on, CSP strict (no remote scripts; images https only).
- `renderer/` — index.html + styles.css + app.js. UI text in Spanish.

## Commands
- `npm start` — run the app.
- `npm run selftest` — headed run that screenshots the first rendered state and exits (use this to verify changes; Read the PNG).

## Conventions
- Modern JS, double quotes, no semicolon omission, descriptive names; comments only where the why isn't obvious.
- PR body HTML comes from GitHub's `bodyHTML` (already sanitized) — do not inject other HTML unescaped; everything else goes through `esc()`.
- Default repo: `Uriach/zinc`. More repos via Settings.
