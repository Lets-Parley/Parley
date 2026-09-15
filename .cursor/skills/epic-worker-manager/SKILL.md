---
name: epic-worker-manager
description: >-
  Drives a whole Parley epic end-to-end and autonomously — pulls a Feature-type
  tracking issue and its native sub-issues from GitHub, partitions them so
  parallel work won't collide, gives each dispatched worker its own git worktree,
  records durable per-issue state in `.claude/epic-state.<epic>.json` so a crashed
  run resumes in seconds, then runs the post-PR loop (review-mesh review, findings
  addressed, green-CI watch, squash-merge, Project Status updated) without asking
  for permission at each step. Use whenever the user names an epic issue (e.g.
  "run epic #47", "ship the accessible-rooms epic", "epic-worker-manager 38",
  "work the next batch of the plugin epic"), asks to coordinate multiple
  sub-issues of an epic in parallel, or asks to resume/continue an epic run that
  died mid-flight.
---

# Epic Worker Manager (Parley) — Cursor

Drive a Parley epic to merged, unattended: discover → partition → one worktree-isolated
worker per sub-issue → review loop until clean → green CI → squash-merge → handoff.

**Announce at start:** "Using epic-worker-manager for epic #\<N\>."

Detailed commands live in `references/` — read each at the step that needs it. The spine
below carries every rule, default, and decision.

## Cursor harness (read once)

This skill is the Cursor port of `.claude/skills/epic-worker-manager`. Same workflow and
state file; different tools.

| Claude Code | Cursor |
|---|---|
| `Agent` (`subagent_type: general-purpose`) | `Task` (`subagent_type: "generalPurpose"`) |
| Default model Opus / Sonnet for fixups | `model: "cursor-grok-4.6-medium"` (Cursor Grok 4.6). If a newer Grok slug is on the Task allow-list, use that. Override only when the user names a different listed model |
| Parallel agents in one message | Multiple `Task` calls in **one** assistant message; wait for the batch before the next |
| `SendMessage` to nudge a live agent | `Task` with `resume: "<agentId>"` and a tight follow-up prompt |
| `ScheduleWakeup` | Local: `/loop` monitored shell (see Supervisor loop). Cloud: `cursor-subscriptions` timer if available |
| `AskUserQuestion` | Ask in the conversation and wait — do not invent a structured questionnaire tool |
| Slash skills (`/epic-worker`, `/review-mesh`, `/address-pr-review`) | **Read** the skill file and follow it (or inline its rules into the `Task` prompt). Paths: `.cursor/skills/<name>/SKILL.md` in-repo, else `~/.cursor/skills/<name>/SKILL.md` |

**Do not** invent a Claude `Agent` / `ScheduleWakeup` / `AskUserQuestion` call — those tools
are not in this harness.

State stays at `.claude/epic-state.<EPIC>.json` so a Claude Code run and a Cursor run can
resume each other. Handoffs go under
`~/.cursor/projects/home-jacorbello-repos-parley/handoffs/` (outside the repo).

## Parley conventions this skill assumes

Verified against the repo; re-check if any of it stops matching reality.

- **Epics are issues with native issue type `Feature`.** There is no `type:epic` label and no
  `phase:N` label. The unit of work is the epic's **native sub-issues** (`Task` type).
- **Labels are `area:core` / `area:web` / `area:db` / `area:plugins` plus the stock set.** They are
  scope hints for partitioning, not workflow state.
- **State lives in the org Project "Parley Roadmap"** (`gh project … --owner Lets-Parley`, number 1),
  field `Status`: Proposed / Backlog / On Deck / In Progress / Blocked / Done.
- **Milestones are versions** (`v0.3.0`). Optional filter, never invented by this skill.
- **`ROADMAP.md` is strategic prose.** This skill never edits it.
- **No Copilot review and no SonarQube, but Cursor Bugbot IS active** and its unresolved threads block
  the merge queue even though its check reports SUCCESS — see `references/review-and-merge.md`. CI is
  `.github/workflows/ci.yml`. **Read the rollup; never hard-code the check list.** The reviewer is
  `review-mesh` (read that skill; run Steps 1–3 only).
- **`.claude/` is globally git-ignored**, so state files need no `.gitignore` edit.

## Inputs

- `EPIC` (required) — the tracking issue number (or enough of its title to identify it). Must be an
  issue whose issue type is `Feature`.
- `BASE_BRANCH` (optional, default `main`).
- `MAX_PARALLEL` (optional, default `3`).
- `MILESTONE` / `AREA` (optional) — restrict to sub-issues on that milestone or carrying that
  `area:*` label, for a "just the v0.3.0 slice" run.
- `--plan-only` — run Steps 0–4, print the plan, write nothing, dispatch nothing, stop.

## Autonomy boundary

This skill runs unattended. Treat "should I ask?" as the expensive branch — a stop costs a human
round-trip, and most historical stops were asking permission the user already granted by launching
the run.

**Proceed without asking:** dispatching workers, batching, review rounds, addressing findings, fixing
CI, resolving conflicts, re-triggering a flaky lane, filing follow-up issues, labeling an issue
`help wanted` for a human, updating Project `Status`, **squash-merging a PR that is review-clean and
CI-green**.

**Stop and ask the user** only for:
- **Production writes** — deploys beyond what CI does on merge, prod DB/DDL, prod secrets, live infra.
- **Anything the permission classifier blocks** — a denied call is a decision, not a retry prompt.
- **A third consecutive failed fix attempt on the same issue** (`fix_attempts == 3`). Two attempts is
  a bad guess; three means the model of the problem is wrong. Mark `blocked`, record
  `blocking_reason`, keep the worktree, ask.
- **A migration that would edit or renumber an already-shipped file** in `internal/db/migrations/`
  (AGENTS.md gotcha 1 — append-only, the running database has applied them).

## Hard rules

- **Every worker gets its own worktree, created by the manager.** Two workers sharing a tree — or the
  `git stash` stack, which is global to the repo — silently eat each other's changes. Do **not** use
  Cursor's `best-of-n-runner` for worker isolation; this skill owns the paths.
- **Before any destructive git operation on a worktree — `reset --hard`, `clean`, `checkout -f`,
  `worktree remove` — run `git -C <worktree> status --porcelain` and require empty output.**
  Non-empty means a worker has live uncommitted work there; there is no stash and no commit to
  recover from, so destroying it is unrecoverable by definition. This holds even when the path
  matches your own convention and even when the state file looks stale — mtime is not liveness. If
  it is non-empty and not yours, stop and report the path. (None of these commands appear anywhere
  in this skill; a manager that finds itself reaching for one is improvising recovery.)
- **No worker ever runs `git stash`.** Restated in the dispatch prompt.
- **Persist after every state transition** (`references/state-and-handoff.md`).
- **Re-read source-of-truth fresh each cycle.** The epic body, the sub-issue list, and `main` all move
  mid-run. Never merge off a Step-3 snapshot.
- **Guard every merge against duplication** — the Step 7 checklist, every time.
- **No AI attribution anywhere.** Subagents inherit the global rule but reaffirm it in the dispatch
  prompt. Strip any `Co-Authored-By` / "Generated with" on returned PRs.
- **Conventional Commits** on every commit. Note there is no release-please here — `release.yml`
  fires on a manually published GitHub Release — so the convention is for readable history, not
  automated changelog generation.
- **Never `git push --force`** on a worker's PR without user say-so.
- **A green `go test ./...` can mean nothing ran.** Integration tests skip without
  `TEST_DATABASE_URL`; the frontend must be built before any Go build. Both are in the dispatch
  prompt and both are checked in pre-flight.
- **Shell hygiene in every poll/loop** — see below.

## Shell hygiene

- **Never iterate unquoted command output.** The Shell tool runs **zsh**, where `for n in $PRS`
  iterates once over the whole string. Build an array: `PRS=(52 54 56); for n in "${PRS[@]}"; do …`.
- **Quote every expansion** — `"$PR"`, `"$REPO"`, `"$f"`.
- **`gh api --jq` does NOT accept jq's `--arg`** — pipe to standalone `jq` for variable injection.
  `gh api … --jq '… $ts …' --arg ts "$X"` mis-parses and, with the usual `|| echo 0`, reads "no
  signal" forever.
- **Test a loop on one item before scaling.**

## Workflow

### 0. Resume check (first thing, before any git operation)
Read `.claude/epic-state.<EPIC>.json`.

**Test for a live owner before treating the file as yours — with git, not with inference.** For every
recorded `worktree`, run `git -C <path> status --porcelain`. Any dirty tree, or any recorded branch
carrying commits newer than that issue's `last_checkpoint`, means a worker is live *right now*: leave
that issue and its tree strictly alone, do not re-dispatch it, and resume only the issues with no
live evidence. **A stale-looking `mtime` is not evidence the owner is dead.** If every recorded tree
is clean and quiet, the previous run is dead: resume normally, no question asked.

This is the whole same-epic guard. It is deliberately a command whose output decides.

Then glob for other `.claude/epic-state.*.json`: any with unfinished issues means a live sibling
manager on a *different* epic. Two epics in different areas coexist fine — report it, don't stop —
but treat every `.claude/` path that isn't yours as read-only. If your file exists and passed the
liveness test above, **resume**: reconcile every issue against live GitHub and continue.
Reconciliation table: **`references/state-and-handoff.md`**. Report the resume in one line. No state
file → create it after Step 3 with every issue at `phase: "dispatched"`, `pr: null`,
`review_rounds: 0`, `fix_attempts: 0`.

### 1. Pre-flight
```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # Lets-Parley/Parley
git fetch origin
git checkout "${BASE_BRANCH:-main}"
git pull --ff-only
gh auth status
```
Three conditions, each with an autonomous remedy:

1. **Clean tree** — no *tracked* modifications (`git status --porcelain | grep -v '^??'`). Untracked
   files are scratch work; never stash them. Tracked changes → stash to a *named* ref
   (`git stash push -m "epic-worker-manager pre-flight <epic> <ISO ts>"`), record it in the state
   file's `stash_ref`, and report it in plain text now and again in the handoff.
2. **Base current with `main`.** If `--ff-only` won't fast-forward, do not rebase or reset — report
   the divergence and dispatch every worktree from `origin/<BASE_BRANCH>` instead.
3. **A usable local toolchain** — `TEST_DATABASE_URL` set (otherwise say so loudly in the run report:
   every worker's integration tests will skip and CI becomes the only real gate), and `web/dist`
   buildable. Neither is a stop; both are reported.

### 2. Find the epic
```bash
gh api graphql -f query='
query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){
  issue(number:$n){number title url state body issueType{name} milestone{title}
    labels(first:20){nodes{name}}
    subIssues(first:100){totalCount nodes{number title url state body
      issueType{name} milestone{title} assignees(first:5){nodes{login}}
      labels(first:20){nodes{name}}
      timelineItems(first:50,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){
        nodes{__typename ... on CrossReferencedEvent{source{__typename ... on PullRequest{number state isDraft url}}}}}}}}}}' \
  -F owner=Lets-Parley -F name=Parley -F n="$EPIC"
```
If `issueType.name != "Feature"`, say so and ask — a `Task` has no sub-issues to drive. If the number
wasn't given, search open Feature issues by title and pick, asking on 2+ plausible matches.

Read the epic body: Parley epic bodies carry **Baseline**, **Scope**, **Out of scope**,
**Constraints**, and **Acceptance criteria** sections. The Constraints section is load-bearing —
extract it verbatim for the dispatch prompt.

### 3. Select the sub-issues
From `subIssues.nodes`, keep those that are `OPEN`, have **no open linked PR** (via `timelineItems`),
and match `MILESTONE` / `AREA` if given. Then triage each as dispatchable or human-only.

**Human-only** means no code change a worker could land: infra/console work, an owner-gated decision,
"someone with credentials does X", or an AC written in the imperative to a person. For each:
`gh issue edit <n> --add-label "help wanted"`, record it `blocked` with a `blocking_reason`, move on.

Zero dispatchable issues → write the handoff and stop (report whether it's because the epic is done
or because everything is human-only).

**Sibling-session guard.** Check this **per issue**, not only when the whole epic looks done. An
issue with an open linked PR, or an existing worktree, or a branch pushed in the last hour, is one
somebody may be driving right now. Verify the recent commits/comments are yours; if you can't, skip
that issue and surface it rather than redriving. Step 0's liveness test covers the trees this file
already knows about; this covers the ones it doesn't.

### 4. Partition for parallelism
Compute a **scope set** per issue — probable paths — and build a conflict graph (edge = overlap), then
greedy graph-color it into batches and chunk each by `MAX_PARALLEL`. Parley's layout makes this
cheap: `area:web` → `web/src/…`, `area:core` → `internal/…` + `cmd/…`, `area:db` →
`internal/db/migrations/` + `internal/store/`, `area:plugins` → `internal/…` per the epic body.

Three Parley-specific collision rules that matter more than path overlap:

- **Two issues both adding a migration always collide.** Serialize them into different batches,
  always.
- **`internal/session/` registry and the wire envelope** — an issue naming `session.Register`, the
  envelope, or the kind registry gets an edge to every other issue in the same area.
- **`web/src/tokens.css`** — treat a tokens edit as overlapping all other `area:web` issues.
- **The shared test harness — `web/src/test/setup.ts` and `web/src/test/render.tsx`** — an issue
  whose scope names either file gets an edge to **every** other `area:web` issue.

**Honor the issue body's own ordering.** Parley sub-issues carry a `## Dependencies` section — read
it as an edge either way. Never dispatch an issue in the same batch as one its body says it should
follow.

Resolve identifiers with `grep -rn` (this repo has no code graph). Print the plan:

```
Epic #47 — feat: a room everyone can actually use  (Lets-Parley/Parley, milestone v0.3.0)
  Sub-issues dispatchable: 4 of 4
  Batches:
    Batch 1 (parallel):
      #48 — text equivalents for every seat…   scope: web/src/components/Table.tsx, ResultsPanel.tsx
      #49 — the standup rail says whose turn…  scope: web/src/pages/StandupRoom.tsx
    Batch 2 (after Batch 1):
      #50 — MemberCard onto the native dialog  scope: web/src/components/MemberCard.tsx, Modal.tsx
      #51 — contrast for the micro-copy tokens scope: web/src/tokens.css  (collides: all area:web)
```
Then proceed — no confirmation gate. Under `--plan-only`, stop here.

### 5. Create worktrees, then dispatch
```bash
git worktree add "../parley-wt-issue-$ISSUE" -b "issue-$ISSUE" "origin/${BASE_BRANCH:-main}"
```
Branching from `origin/<base>` keeps a drifted local base out of the worker's branch. Existing path or
branch (resumed run) → reuse, don't clobber. Record `worktree`/`branch`, transition to `dispatched`,
set the issue's Project `Status` to **In Progress** and assign it to the user
(`gh issue edit <n> --add-assignee @me`).

Then one `Task` per issue **in the same message** per batch, `subagent_type: "generalPurpose"`.
`epic-worker` is a **skill inlined into the prompt**, not a Task `subagent_type` (passing it errors).
Set `model: "cursor-grok-4.6-medium"` (Cursor Grok 4.6; bump to the newest Grok slug on the Task
allow-list). Override only if the user named a different listed model. Bundle the
already-fetched context. Wait for the batch before the next.
**Read `references/dispatch.md`** for the full worker prompt and the `WORKER_REPORT` block.

### 6. Collect reports
Parse each `WORKER_REPORT`; write `pr` and `phase: "in_review"`. A worker back with no PR → `blocked`
with the reason, keep the worktree, Project `Status` → **Blocked**, carry it to the handoff.

### 7-loop. Post-PR review loop
**Read `references/review-and-merge.md`.** In short: `review-mesh` Steps 1–3 once per PR is the
review; `github-code-quality[bot]` and `cursor[bot]` inline comments are polled every round and
verified, never blind-fixed; findings are addressed by a `Task` (Cursor Grok 4.6) that pushes a fixup;
`MAX_ROUNDS` default 4. Then watch CI (`gh pr checks "$PR" --watch`) — every check in the rollup green.

**Failed fixes count.** A round whose fix doesn't clear the finding, or a CI fix that leaves CI red,
increments `fix_attempts`; success resets it to 0. At 3, stop on that issue per the autonomy boundary.

### 7. Merge + housekeeping
Run the pre-merge duplication checklist per PR (empty diff / issue closed / sibling PR) — any
`DUP-WARN` blocks that merge and becomes a handoff entry. A PR clearing it with a clean review and
green CI is merged autonomously: `gh pr merge "$PR" --squash` (no `--delete-branch`). Then `phase:
"merged"`, Project `Status` → **Done**, remove that issue's worktree. GitHub closes the sub-issue from
`Closes #<n>` and updates the epic's sub-issue progress itself — **do not hand-edit the epic body.**
Detail in `references/review-and-merge.md`.

### 8. Handoff + final report
When the epic completes or fully blocks, write
`~/.cursor/projects/home-jacorbello-repos-parley/handoffs/epic-<EPIC>.md` — outside the repo, so it
never lands in a PR. Template and final report block: **`references/state-and-handoff.md`**.

## Supervisor loop

**The rule is about turn boundaries, not about CI.** Every time you finish a turn without a `Task`
running, the run is over unless a wakeup is armed — nothing wakes you up on its own. So the decision
"do I arm a wakeup?" belongs at *every* stop, not only the ones that feel like waiting.

While any issue is in `awaiting_ci` or `in_review` and nothing else is runnable:

1. Read the **loop** skill (`.cursor/skills-cursor/loop/SKILL.md` or invoke `/loop`).
2. Arm a local monitored one-shot (or fixed loop) with ~`1200` seconds delay and sentinel
   `AGENT_LOOP_WAKE_epic-<EPIC>`, payload naming the epic and which PRs are waited on.
3. On wake: re-read state, reconcile against GitHub, advance, and either re-arm or finish.

A dispatched `Task` finishing re-invokes you via the completion notification — the timer is the
fallback for external state GitHub owns, not a poll of your own subagents. When every issue is
`merged` or `blocked`, **stop** the loop (kill the sleeper PID / unsubscribe) and do not re-arm.

**`gh pr checks --watch` is a foreground block, and that is the trade-off.** It holds the turn open,
so no wakeup is needed while it runs — but it burns the turn on one PR and returns you to a stop with
nothing armed. After any `--watch` returns you are at a turn boundary: re-arm or finish, deliberately.

> Exactly one of these three is true every time you stop: a `Task` is running, a wakeup is armed, or
> every issue is `merged`/`blocked`. If none holds, you have ended the run by accident.

## Failure modes

| Situation | Action |
|---|---|
| Manager died mid-run (API 5xx, crash, compaction) | Step 0 resume. Reconcile against GitHub. Never re-dispatch an issue that already has a PR. |
| `main` won't fast-forward | Don't rebase the primary checkout. Dispatch from `origin/main`, report it. |
| Epic issue isn't type `Feature` / has no sub-issues | Ask. A `Task` is a single-issue job for `epic-worker`, not this skill. |
| Two workers both wrote a migration with the same version prefix | Partition bug (Step 4). Serialize: hold the second PR, rebase it onto merged `main`, renumber *its own* new migration only. Never renumber a merged one. |
| CI `go` red but green locally | Almost always `TEST_DATABASE_URL` unset locally. Check that before blaming CI. |
| `go` or `docker build and smoke` red with `pattern all:dist: no matching files found` | Worker skipped `cd web && npm ci && npm run build`. Rebuild and push. |
| `docker build and smoke` red but `go`/`web` green | Migration or `go:embed` mistake — real defect. |
| PR looks clean but has unread `github-code-quality[bot]` / `cursor[bot]` comments | Poll `gh api repos/$REPO/pulls/$PR/comments` and read every author. Verify each. |
| Pre-merge `DUP-WARN` | Don't merge — hold, note in the handoff, close the duplicate with a note. |
| A poll reports "no signal" but the review is clearly on the PR | Almost always shell hygiene, not a quiet reviewer. Run the loop body once by hand. |
| Run silently ended with PRs still open | Stopped with no `Task` running and no wakeup armed. Re-read state, re-arm `/loop`, continue. |
| CI fails on a flake unrelated to the diff | One re-trigger, then surface. Don't paper over it. |
| You catch yourself adding "Generated with …" / `Co-Authored-By` | Strip it before pushing. |

## Integration

- **Calls:** `epic-worker` (inlined into the dispatch prompt), `review-mesh` (Steps 1–3 only, once
  per PR — read the skill and drive it with `Task`), `address-pr-review` (per review round when
  findings are GitHub threads), loop skill for wakeups.
- **Does not call** `using-git-worktrees` or Cursor `best-of-n-runner` for workers — the manager
  owns worktree creation.
- **Related:** `plan-feature` / `create-epic` produce the epics this skill consumes;
  `epic-completion` (`.cursor/skills/epic-completion`) audits one afterwards.
- **State:** `.claude/epic-state.<EPIC>.json` is bookkeeping only. GitHub is the source of truth; on
  any conflict, GitHub wins.

## Additional resources

- [references/dispatch.md](references/dispatch.md) — worker `Task` prompt + `WORKER_REPORT`
- [references/review-and-merge.md](references/review-and-merge.md) — mesh, Bugbot, CI, merge
- [references/state-and-handoff.md](references/state-and-handoff.md) — state schema, resume, handoff
