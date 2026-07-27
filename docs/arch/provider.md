# Provider abstraction (GitHub ⇄ GitLab)

Read this when touching `src/provider.js`, `src/gitlab.js`, `src/github.js`, or anything that
consumes PR data in the renderer.

- `gitlab.js` maps Merge Requests → PR shape. **Critical: the renderer branches on exact enum literals**, not shape. Emit GitHub tokens exactly: `state` OPEN/MERGED/CLOSED, `reviewDecision` APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED, `mergeable` MERGEABLE/CONFLICTING, `mergeStateStatus` CLEAN/UNSTABLE/HAS_HOOKS/BEHIND/BLOCKED/DIRTY, `commits.nodes[0].commit.statusCheckRollup.state` SUCCESS/FAILURE/ERROR/PENDING/EXPECTED.
- Mutations: the renderer passes `pr.id` (a node id). GitLab encodes it as `gl:<projectEnc>#<iid>`; `updateBranchRebase`/`setPrDraft`/`revertPullRequest` decode it.
- GitLab caveats (API ≠ GitHub): **no force-update ref** → `forceUpdateBranch` does delete+recreate (non-atomic: checks the SHA exists first and reports it if recreate fails; still fails on protected/open-MR branches); **revert** creates a direct commit, not an MR (`{number:null, url}`); **REQUEST_CHANGES** has no universal verdict → posts a note; list rows omit per-MR additions/deletions and pipeline status (only the detail view fetches them).
- **`submitReview` is not atomic** on GitLab (no single-POST review like GitHub's `/reviews`): it posts N inline discussions + a note + approve in sequence. If it fails mid-way, published comments stay AND the local draft is intact → a retry can duplicate. Future fix: GitLab `draft_notes/bulk_publish`.
- **`listPRs` does N+1 on GitLab** (one `/approvals` call per open MR, every poll) to populate the facepile + review decision. Fine for small projects; watch rate limits on large self-hosted instances.
- **Hotfix cherry-pick** (GitLab-only): after merging an MR whose source branch starts with the configured prefix (default `hotfix/`), the renderer offers to replicate the MR content onto other branches. Targets = config `branches` (default `["development"]`) + the sibling `-mx` branch of the merge's target release branch (derived: `rb/x` ⇄ `rb/x-mx`, only for `rb/…`/`-mx` bases). It cherry-picks the **merge commit SHA** (`mergePR` returns `sha`), which GitLab applies as the whole MR diff. **Never auto-fires**: a post-merge modal dry-runs each target (`cherry_pick` with `dry_run:true`) and shows ✓/✗ per branch before the user confirms. **Non-atomic across N branches**: applied sequentially, partial failure leaves some branches done; reported per-branch. First-real-use check: eyeball the resulting diff on a target branch is the full hotfix, not an empty commit.
- GitLab notes are markdown (no sanitized HTML): `gitlab.js` escapes them into safe HTML. Do not inject GitLab note/description text unescaped.

## GitLab-only surface

`cherryPick`, `listMilestones`/`milestoneIssues`, `releaseDefaults`/`generateReleaseBranches`,
`nextReleaseTag`/`createReleases`/`releaseStatus`, `projectEnvironments`, `groupLabels`/
`groupProjects`/`updateIssue`, `saveMilestoneSummary` are GitLab-only — the GitHub side has
throwing stubs kept **only for interface parity**. Those features are gated to
`provider==="gitlab"` in the renderer.

## Multi-repo

`state.repo === "__all__"` aggregates across repos (GitHub: GraphQL search; GitLab: per-project
list); detail/drafts/merge must use `detailRepo()` (the PR's own repo), never `state.repo`
directly.
