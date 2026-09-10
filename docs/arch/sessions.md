# Claude Code sessions pane (left, next to the menu)

Toggle `#sessions-btn` (the "Agents" entry at the very top of the menu; it uses `.open`, not `.active`, which every view clears from all `.bucket`s) → `aside#sessions-pane` (right after `nav#sidebar`), `renderer/app/sessions.js` + `src/sessions.js` + `src/ipc/sessions.js`.
Provider-agnostic; open/closed is remembered in `localStorage` (`monstro:sessionsPane`), not config.
While open, `body.nav-collapsed` folds the menu to a 52 px icon rail (still clickable; names as tooltips).

## Layout ("Actividad" design)

Sections: **Esperándote** (cards with the question Claude left, first 4 + "ver N más"), **Trabajando** (cards with the running tool), **Sin pendientes** (`done`: process still open somewhere, nothing asked — full cards, blue dot, so their MRs stay clickable), **Terminadas** (`finished` only = process closed: compact rows with Reanudar and their MR/epic badges). An open session never lands in Terminadas. The topbar counter = sessions waiting for you.

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

## Incremental read

Transcripts are append-only and reach 10 MB. `scanTranscript` keeps `{offset, …acc}` per file and only reads new bytes up to the last `\n` (a half-written line waits for the next poll). One scan per file at a time (`inflightScans`) so overlapping polls can't double-count. Truncation → rescan from zero.

## Manual badges

`userData/session-tags.json` `{[sessionId]: {add: [url], hide: [key]}}` — own file, so it doesn't go through the `config:set` whitelist. `×` on a manual badge removes it; on an inferred one hides it for that session.

## Actions (main validates, never trusts renderer paths)

`sessions:list` keeps the last snapshot; `openEditor`/`resume` only act on sessions and dirs from it.
- Open: `agents.openEditor(dir)` → `.sln/.csproj` ⇒ Rider, else VS Code (`editorStack`).
- Focus (live only, click on the card title → `sessions:focus`). Host = first known ancestor in the process chain (one `ps -A` per list, `hostFromChain`):
  - `vscode-ext` (`Code Helper (Plugin)`): `open -a "Visual Studio Code" <startDir>` + `vscode://Anthropic.claude-code/open?session=<id>` (the extension's `handleUri`) → **exact tab**.
  - `vscode` (integrated terminal) / `rider`: `open -a <app> <startDir>` → brings that project's window to front; the terminal tab can't be picked from outside.
  - `ghostty`: AppleScript (Ghostty 1.3+) **exposes no TTY and no surface id**, and Claude doesn't retitle an idle session, so Monstro titles the tab itself: writes an OSC 2 with a unique marker to the session's TTY (from `ps`, validated `ttysN`; the terminal consumes it, the TUI never sees it), finds the terminal whose `name` is exactly the marker, `focus`es it, then leaves the session title on the tab. **A forced `title=` in the Ghostty config makes Ghostty ignore OSC titles** → nothing matches (toast).
  - `terminal`/`iterm`: only activated (`open -a` with a folder would open a new window).
- Resume (finished only): Terminal via `osascript … do script (item 1 of argv)` running `cd '<start cwd>' && claude --resume <id>` — the command goes through argv, never interpolated into AppleScript. Start cwd because `--resume` looks the transcript up by the cwd the session started in.
- MR/PR badge of a configured repo → closes the pane and `openDetail(iid, "changes", project)` (wide, full width). Other MRs/PRs → `openExternal` on their `/diffs` / `/files`; issues/epics → `openExternal`.
- Review sessions (`review: true` = the transcript has a real `"skill":"mr-review-gitlab"` Skill call; mentions in text are escaped and don't count) also set `state.focusPendingDrafts`, so the Changes tab scrolls to the first **GitLab draft note**. Those come from `prConversation` (GitLab: `/draft_notes` fetched with the discussions), flagged `isPendingDraft` (positioned → review thread, `position_type: "text"` → general comment) and rendered amber, without reply/resolve; `pendingDrafts` feeds the "N pendientes de publicar" bar. Publishing stays in GitLab (never auto-publish).

Check: `node scripts/test-sessions.js`. Screenshot: `--selftest-route=sessions`.
