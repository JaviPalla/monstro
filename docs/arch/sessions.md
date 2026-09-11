# Claude Code sessions pane (left, next to the menu)

Toggle `#sessions-btn` (the "Agents" entry at the very top of the menu; it uses `.open`, not `.active`, which every view clears from all `.bucket`s) → `aside#sessions-pane` (right after `nav#sidebar`), `renderer/app/sessions.js` + `src/sessions.js` + `src/ipc/sessions.js`.
Provider-agnostic. The app always starts on the Agents board (`initSessions`; the selftest starts on the list so its routes keep working); open/closed is not remembered.
While open, `body.nav-collapsed` folds the menu to a 52 px icon rail (still clickable; names as tooltips).

**Two modes, decided in CSS from the DOM** (`#layout:has(#detail-pane.hidden)`, no JS state): with nothing in the detail pane, Agents is a **board** — full screen, `#list-pane` hidden, each section an `.ss-grid`. Opening a ficha (or an MR) in the detail pane shrinks it back to the 340 px column. Opening the pane hides any open detail, so pressing Agents always lands on the board. **Every view calls `closeDetail()` on entry**, so `closeDetail()` also leaves Agents (the board would cover the view otherwise — the palette and the `h`/`m`/digit shortcuts navigate without touching the menu); `hideDetail()` only hides the detail, and is what ✕ / Esc / a second click use to go from a ficha back to the board.

## Layout ("Actividad" design)

Sections: **Esperándote** (cards with the question Claude left, first 4 + "ver N más"), **Trabajando** (cards with the running tool), **Sin pendientes** (`done`: process still open somewhere, nothing asked — full cards, blue dot, so their MRs stay clickable), **Terminadas** (`finished` only = process closed: compact rows with Reanudar and their MR/epic badges). An open session never lands in Terminadas. The topbar counter = sessions waiting for you. A click on a card or row (anywhere but its buttons / tag form) opens its **ficha** (below); the card of the open ficha is marked `.selected`.

State (`sessionActivity`): `waiting` (needs you), `working`, `done` (process open, work delivered), `finished` (process gone). Session file `status` `waiting` (+`waitingFor`, e.g. a permission) → waiting; `busy` → working; **`idle` is NOT "waiting for you"** — terminals stay open for days after the work is done, so an idle session only counts as waiting when one of its last two paragraphs **ends** with a question mark (`closing`); a rhetorical "¿Y sabes por qué? Porque…" is followed by its answer and doesn't count; otherwise it is `done`. The VS Code extension writes **no `status`**, so it is inferred from the transcript (`lastTurn`): last `assistant` line newer than the last `user` line with `stop_reason: "end_turn"` → same question rule; otherwise working, unless there has been no activity for 2 min (a pending permission looks exactly like a running tool).

Live dedupe: the extension relaunches the process on resume and the old one can stay alive with the same `sessionId` → one row per session, newest `startedAt`. Sessions without a transcript (fresh, or the extension's spare process) are hidden. Only the last assistant line is kept raw and parsed lazily; `"type":"assistant"`/`"type":"user"` substring matches were checked against 25k real lines with zero false positives.

## Sources (no API — what the CLI leaves on disk)

- **Live**: `~/.claude/sessions/<pid>.json` (`pid, sessionId, cwd, name, status, entrypoint, kind`). Live = `process.kill(pid, 0)` doesn't throw ESRCH. Only `kind: "interactive"`.
- **Transcripts**: `~/.claude/projects/<dir>/<sessionId>.jsonl`, depth 2 only (subagent transcripts live deeper). Indexed by file name, never by guessing how the cwd is encoded.
- **Finished** = transcript touched in the last 24h, not live, with a title, and **not `entrypoint: "sdk-cli"`** — that's a headless `claude -p` (Monstro's own AI review / agents).

## What's inferred from a transcript

Regexes over the raw line — **a JSON embedded in a tool_result is escaped (`\"cwd\":\"…\"`) and doesn't match**, so only top-level fields and tool-call inputs count.

- Title: `custom-title` > `ai-title` > `agent-name` > clipped `last-prompt` > session `name`.
- Repos: every `cwd` + the dir of every `"file_path"` → walk up to `.git` (file or dir, so worktrees work) → `origin` → `remotePath()`. `$HOME` and `~/.claude` never count. Branch = last `gitBranch` seen in that cwd.
- Links: GitLab `…/-/merge_requests|issues|work_items/N` and GitHub `…/pull|issues/N` anywhere, plus `pr-link` entries. **Epic = issue whose project ends in `/epics`** (same rule as `isEpicUrl`). Kept only if host = configured provider host AND top-level group ∈ groups of `config.repos` (drops docs URLs); `pr-link` always kept.
- Branch → MR: `mrForBranch(project, branch)` (GitLab only; GitHub stub returns null because `pr-link` covers it), cached 5 min in the IPC, skipping trunk (`development|main|master|HEAD|rb/*`).

## Launcher ("¿Qué quieres hacer?" — board mode only, GitLab only)

`launcherHtml` sits on top of the board (CSS hides it in column mode). Its state lives in `sessionsUi.launch` and fields are saved on `input`, so the 10 s repaint never loses what you typed. Every action opens an **interactive** `claude` session in a new **Ghostty** tab (`openInGhostty`: AppleScript `new tab in front window with configuration {initial working directory, initial input}`). The command is **typed into your shell** — your PATH and your `glab`, and the tab survives `claude` exiting; dir and command travel as argv, never interpolated into the script, and every value inside the command is single-quoted (`claudeCommand` / `shellQuote`, tested against `'; rm -rf ~`). Multi-line prompts work (a real run typed `'uno⏎dos'` and zsh got both lines). Being interactive, the agents land on the board like any other session and ask for your permissions — nothing runs with `bypassPermissions`. Resume uses the same launcher.

- **Review de MR** — link of an MR, a task or an epic. `sessions:launchTargets` resolves the MRs with `taskMergeRequests` (the task's closing + related MRs; for an epic also its hierarchy children **and** its `/links`, because Monstro's own "Crear tarea" links tasks instead of nesting them) and each one's local clone (`scanRepos(rootDir)` by `origin`). You see every MR found — the ones that can't be launched greyed out with the reason (`skip`: merged / closed, no local clone), because "no MRs" and "all merged" mean different things to whoever pasted the link — then "Lanzar N": `sessions:launch` **re-resolves in main** (the renderer only sends the link) and opens one tab per **open** MR with a clone: `claude -n 'Review !N' '/mr-review-gitlab <url>'`. The skill makes its own worktree next to the clone. A slash-command launch leaves no Skill tool call, so `review: true` also comes from a real prompt starting with `/mr-review-gitlab` (tool results quoting it don't count).
- **Pruebas y casos de uso** — same resolution, open **and merged** MRs → `/qa-checklist-gitlab <mr url> [task url]` (user skill, `~/.claude/skills/qa-checklist-gitlab`): reads the MR in a detached worktree and writes a `## Puntos a comprobar` checklist as a comment on the task (on the MR if there is none) — **only after you say yes in the session**: an issue comment is public at once, GitLab has no issue drafts.
- **Implementar tarea** — prompt + a folder from `sessions:pickDir` (must be a git repo; main only launches in dirs picked through that dialog this run) → `claude -w <slug> -n 'Implementar: …' '<prompt + instructions>'`. Claude decides epic vs task, proposes it, creates it with `glab` **after your OK**, then works in the `-w` worktree and asks before push / MR.

Tripwire (skills, not Monstro): Claude Code runs as a **shell command** any `!` + backtick-quoted text in a SKILL.md whose `!` is at line start or right after whitespace — on every load, `/skill` or Skill tool. `mr-review-gitlab` quoted a phrase ending in `casi !` inside backticks and the review died with `command not found: Necesitas` before starting; its quotes that end in ` !` now use «». Check a skill with `rg -n '(^|\s)!`' SKILL.md`.

## Ficha (big view of one session)

`sessionView` renders into `#detail-content` with `#detail-pane.wide` (like an MR in Cambios; ✕ / Esc / a second click on the card go back to the board via `hideDetail()`; closing the pane closes it too). Which session is shown is read **from the DOM** (`viewingId()` = `.sv[data-id]` while the pane is visible), so when an MR or another view takes the pane, the poll stops repainting it. It repaints on every poll only if the session's JSON changed (keeps text selection and scroll). No IPC of its own: the fields ride on `sessions:list` (a few KB per session).

What it shows, all from the transcript (no AI):
- **Resumen de Claude Code** = last `system` / `away_summary` (`content`, one plain-text line). **CLI only** — the VS Code extension never writes it; then you only see the state line (last paragraph / question / running tool), same as the card.
- **Tus peticiones** = `user` lines that are neither tool results (`"tool_use_id"`) nor `"isMeta":true` nor `isCompactSummary`. CLI/IDE wrappers are stripped (`system-reminder`, `ide_*`, `local-command-*`, `command-message`, `bash-std*`, `task-notification`); slash commands become `/name args`; `[Request interrupted…]` is dropped. Clipped to 500 chars.
- **Ficheros editados** = `toolUseResult.structuredPatch` on the tool-result line: only present when the Edit/Write was **applied** (a failed Edit leaves an error string). `+`/`-` lines of the hunks; a Write that creates the file has no hunks → its `content` lines count as added. Shown relative to their repo (`repoOf`), `~` otherwise.
- **Métricas**: prompts, files, lines +/− (both entrypoints); time Claude worked = sum of `system` / `turn_duration.durationMs` and cost = last `cost-state.totalCostUSD` — **CLI only**, tiles omitted when absent.

## Incremental read

Transcripts are append-only and reach 10 MB. `scanTranscript` keeps `{offset, …acc}` per file and only reads new bytes up to the last `\n` (a half-written line waits for the next poll). One scan per file at a time (`inflightScans`) so overlapping polls can't double-count. Truncation → rescan from zero.

## Manual badges

`userData/session-tags.json` `{[sessionId]: {add: [url], hide: [key]}}` — own file, so it doesn't go through the `config:set` whitelist. `×` on a manual badge removes it; on an inferred one hides it for that session.

## Actions (main validates, never trusts renderer paths)

`sessions:list` keeps the last snapshot; `openEditor`/`resume` only act on sessions and dirs from it.
- Open: `agents.openEditor(dir)` → `.sln/.csproj` ⇒ Rider, else VS Code (`editorStack`).
- Focus (live only, the "Ir a {app}" button on the card or the ficha → `sessions:focus`). Host = first known ancestor in the process chain (one `ps -A` per list, `hostFromChain`):
  - `vscode-ext` (`Code Helper (Plugin)`): `open -a "Visual Studio Code" <startDir>` + `vscode://Anthropic.claude-code/open?session=<id>` (the extension's `handleUri`) → **exact tab**.
  - `vscode` (integrated terminal) / `rider`: `open -a <app> <startDir>` → brings that project's window to front; the terminal tab can't be picked from outside.
  - `ghostty`: AppleScript (Ghostty 1.3+) **exposes no TTY and no surface id**, and Claude doesn't retitle an idle session, so Monstro titles the tab itself: writes an OSC 2 with a unique marker to the session's TTY (from `ps`, validated `ttysN`; the terminal consumes it, the TUI never sees it), finds the terminal whose `name` is exactly the marker, `focus`es it, then leaves the session title on the tab. **A forced `title=` in the Ghostty config makes Ghostty ignore OSC titles** → nothing matches (toast).
  - `terminal`/`iterm`: only activated (`open -a` with a folder would open a new window).
- Resume (finished only): a new Ghostty tab through the launcher (`openInGhostty`) in the start cwd, typing `claude --resume <id>` (validated UUID). Start cwd because `--resume` looks the transcript up by the cwd the session started in.
- MR/PR badge of a configured repo → closes the pane and `openDetail(iid, "changes", project)` (wide, full width). Other MRs/PRs → `openExternal` on their `/diffs` / `/files`; issues/epics → `openExternal`.
- Review sessions (`review: true` = the transcript has a real `"skill":"mr-review-gitlab"` Skill call; mentions in text are escaped and don't count) also set `state.focusPendingDrafts`, so the Changes tab scrolls to the first **GitLab draft note**. Those come from `prConversation` (GitLab: `/draft_notes` fetched with the discussions), flagged `isPendingDraft` (positioned → review thread, `position_type: "text"` → general comment) and rendered amber, without reply/resolve but editable in place (✏️ → `updateDraftNote`, `PUT …/draft_notes/:id`: only the text changes, it stays unpublished — **the PUT must resend `position`**: GitLab does `update!(note:, position: params[:position])`, so omitting it wipes the anchor and the draft drops out of its line into the general comments; `updateDraftNote` GETs the note first and sends its position back) and deletable (🗑 → `deleteDraftNote`, after a confirm: GitLab has no undo); `pendingDrafts` feeds the "N pendientes de publicar" bar. Its "Publicar en GitLab" (also in ⌘P) publishes them from Monstro: native confirm → `publishDraftNotes` (`POST …/draft_notes/bulk_publish`, all of your drafts on the MR at once). Never without that click + confirm.

Check: `node scripts/test-sessions.js`. Screenshots: `--selftest-route=sessions`, `--selftest-route=sessions-view` (ficha of the session with most prompts), `--selftest-route=sessions-launch` (launcher resolving against GitLab the first epic / task / MR link found in your sessions — read-only, launches nothing).
