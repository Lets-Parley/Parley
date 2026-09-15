# Post-PR review loop, CI watch, and merge (Cursor)

Parley has **no Copilot review and no SonarQube**, but it **does have Cursor Bugbot** — the signals
on a Parley PR are:

0. **`cursor[bot]` inline comments.** Its *check* reports SUCCESS regardless, and it posts no review
   object, so a poll that watches checks or reviews reports the PR clean while its comments sit
   unread — and its **unresolved threads silently block the merge queue** (`mergeStateStatus: BLOCKED`
   with every check green is the signature). Read `gh api repos/$REPO/pulls/$PR/comments`, verify each
   finding against the code, fix or push back, reply on the thread, then resolve it via GraphQL
   `resolveReviewThread` or the queue will never take the PR.
   **Do not treat it as a nice-to-have.** On epic #282 it found four real defects the five-agent mesh
   missed across two PRs, including a privilege escalation — its findings tend to live in the *seam
   between* two mandates, which is exactly what per-mandate agents do not cover.
1. **`review-mesh`** — the repo-agnostic adversarial reviewer, and the primary review for this loop.
   Read `.cursor/skills/review-mesh/SKILL.md` if present, else `~/.cursor/skills/review-mesh/SKILL.md`,
   and drive Steps 1–3 with Cursor `Task` subagents (`generalPurpose`), not Claude Code `Agent` calls.
2. **`github-code-quality[bot]` inline comments**, when GitHub emits them. They post to
   `gh api repos/$REPO/pulls/$PR/comments` only — no review object, no status check — so a poll that
   watches reviews and checks reports a PR clean while its comments sit unread.
3. **The CI checks — which ones run depends on the diff.** `ci.yml` runs on every PR and reports
   `go`, `web`, `site`, `dependency review`, `dco`, `docker build and smoke`, `build-push-action arg
   passthrough`, `container scan`, `helm chart`, and `required / gate`; `codeql.yml` adds `analyze`.
   `site.yml` is path-filtered to `site/**` and adds `build` and `deploy` on top of those.
   Beware two name collisions: ci.yml has its own **unfiltered `site` job**, which is NOT the
   separate path-filtered `site.yml` workflow — a PR touching `site/**` gets both, so such a PR
   carries ~15 checks against ~13 for a code-only PR. Note `deploy` is not a required check, so a
   red `deploy` still reads as `mergeStateStatus: CLEAN`. The rollup also
   carries `CodeQL` and `grype`, which are GitHub Advanced Security check-runs derived from the SARIF
   that `analyze` and `container scan` upload, not workflows of their own. Never hard-code the
   expected check list — read the rollup and require every check that actually ran.
4. **A human review**, if the user leaves one. Always address it before merging; it outranks the mesh.

```bash
ROUND=1; MAX_ROUNDS=4   # backstop against nitpick churn; surface-and-stop, never loop forever
```

## Round 1 — the review

Run **`review-mesh` Steps 1–3 only** (materialize → dispatch → aggregate). Do **not** run its Step 4
fix-and-re-run loop: this loop already owns rounds, capping, and state, and nesting two fix loops
makes `review_rounds` meaningless. The aggregated report *is* this round's review.

In the same round, read every inline comment author:
```bash
gh api "repos/$REPO/pulls/$PR/comments" \
  --jq '.[] | {author: .user.login, path, line, body: .body[0:200]}'
gh api "repos/$REPO/pulls/$PR/reviews" \
  --jq '.[] | select(.state != "PENDING") | {author: .user.login, state, body: .body[0:200]}'
```
**A mesh agent that returns a bare `{"verdict":"PASS","findings":[]}` has not reviewed anything** —
its own prompt forbids it, and an evidence-free PASS is indistinguishable from a crashed agent.
`resume` that `Task` with a follow-up naming the specific checks you need output for; it costs one
turn and on epic #282 the re-runs produced some of the best findings of the run. Never aggregate a
bare PASS.

**A mesh agent that stops mid-review is not still working — it is dead.** A subagent's turn ends
when it stops; nothing wakes it, no background command's result reaches it, and its transcript is
lost. Two agents on epic #282's second wave ended with "waiting for the background test run" and
"I'll wait for the monitor's notification" — from the outside, indistinguishable from a review in
progress. Say in every review prompt: *nothing wakes you, do not start a suite you cannot finish
inline, and label what you could not check as UNSUPPORTED rather than omitting it.* When one does
stall, `resume` it once naming the checks only it was assigned; if it comes back with no new tool
calls, it is stuck — dispatch a fresh `Task` on a tighter scope rather than nudging again. The
replacement on #307 finished in 6 tool calls and 55 seconds what the stalled one had failed to
report twice.

`github-code-quality[bot]` findings are low-severity static analysis and frequently false positives.
**Verify each against the actual code** (grep the symbol repo-wide, tests included) and either fix it
or record the one-line reason it's a false positive in the handoff. Never merge with them merely
unexamined.

The mesh burns real tokens, so run it **at most once per PR**. Map its verdict:

| Verdict | Reviewed? | Action |
|---|---|---|
| **PASS** | ✅ clean | Advance to the CI watch. |
| **WARN** | ✅ | Address real findings; a WARN alone doesn't block the merge. Wording nits → note and progress. |
| **BLOCK** | ✅ not clean | Feed CRITICAL/HIGH into the address pass. |

If `review-mesh` isn't available in the session, fall back once to a skeptical
`requesting-code-review` `Task` (Cursor Grok 4.6 / `cursor-grok-4.6-medium`; same model rules as workers), framed *"find real problems,
don't rubber-stamp."* Fill `{BASE_SHA}` from
`git merge-base origin/$BASE_BRANCH <PR_HEAD_SHA>` and re-fetch `{HEAD_SHA}` each round
(`gh pr view "$PR" --json headRefOid -q .headRefOid`) — it moves after every fixup push.

## Addressing findings

Set `phase: "fixing"`. Dispatch a `generalPurpose` `Task` (`model: "cursor-grok-4.6-medium"` unless the user named a different listed model)
with the findings embedded:

```
You are fixing issues a skeptical code reviewer flagged on PR #<PR> in Lets-Parley/Parley.
Worktree: <PATH>     Branch: <BRANCH>     Base: <BASE_BRANCH>

Findings:
<<<
<paste the mesh's ranked findings, or the inline-comment bodies with file:line, verbatim>
>>>

For each BLOCK/CRITICAL and WARN/IMPORTANT finding:
- Read the cited file:line.
- Apply the fix, or push back in your report with the reason (for a mesh finding there is no GitHub
  thread to reply to; for an inline bot comment, reply on the thread).
- Re-run the affected tests. `cd web && npm ci && npm run build` before any go build/test;
  `go test -p 1 -race ./...` with TEST_DATABASE_URL set; `cd web && npm test && npm run lint`.
- Commit with Conventional Commits (fix:/refactor:/test:). No AI attribution, no Co-Authored-By.
Defer MINOR findings unless trivial. Report the commit SHAs and which findings were addressed vs deferred.
```
When findings come from GitHub review threads rather than the mesh, read and follow
`address-pr-review` (`.cursor/skills/address-pr-review/SKILL.md` or `~/.cursor/skills/address-pr-review/SKILL.md`)
if installed — it fetches, replies, and resolves the threads properly. Drive any of its subagents with
Cursor `Task`. If that skill is absent, do the same loop yourself: reply on each thread, push a
fixup, then resolve via GraphQL `resolveReviewThread`.

After the push, set `phase: "in_review"`, `ROUND=$((ROUND+1))`, and re-poll the inline comments only
(the mesh does not re-run). Exit the loop when a round has nothing left to address, or at
`ROUND > MAX_ROUNDS` — **carrying any unresolved findings into the merge decision**. A silent exit
reads as "clean" when it isn't.

If the address pass pushed nothing (everything deferred or pushed back), exit immediately; no new
signal is coming.

## CI watch

```bash
gh pr checks "$PR" --watch --fail-fast=false
gh pr view "$PR" --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | {name, status, conclusion}]'
```
Every check in the rollup should be `COMPLETED`/`SUCCESS` — 13 on a code-only PR, ~15 when the diff
touches `site/**` and `site.yml` adds `build`/`deploy`. Neither of those is *required*, so judge the
required set (`required / gate`, `analyze`) separately from the full rollup. A PR that edits both `web/` and
`site/` (a design-token change is the usual one, since `site/src/styles/parley.css` hardcodes the same
values) has five. Read the failure before
fixing it — the three failures this repo actually produces are distinguishable at a glance:

- `pattern all:dist: no matching files found` → the worker skipped the web build. Rebuild and push.
- `docker build and smoke` red with `go`/`web` green → a migration or `go:embed` mistake. That job boots the Docker
  image against an empty database precisely to catch it. Real defect, never a flake.
- `go` red on a package that passed locally → the local run had no `TEST_DATABASE_URL` and skipped
  the integration tests. Fix the code, not the CI.

One fix attempt (`Task`, Cursor Grok 4.6), then loop back. Still red after
one attempt → `fix_attempts + 1` and, at 3, stop per the autonomy boundary with the failing check name
and log link. A genuinely flaky lane may be re-triggered once without asking; don't paper over it.
Set `phase: "awaiting_ci"` while watching.

## Pre-merge duplication checklist

Run per PR, immediately before merging. While this PR sat in review, siblings merged and `main` moved
— a "ready" PR can have quietly become a duplicate or a no-op. `$ISSUE` is from `WORKER_REPORT.issue`:

```bash
git fetch origin "$BASE_BRANCH" --quiet      # refresh; do NOT reuse the Step-1 pull

# (a) empty diff vs current base → the work already landed
[ -n "$(gh pr diff "$PR" --repo "$REPO" 2>/dev/null)" ] \
  || echo "DUP-WARN #$PR: empty diff vs $BASE_BRANCH — likely already merged."

# (b) issue already closed → a sibling resolved it
[ "$(gh issue view "$ISSUE" --repo "$REPO" --json state -q .state)" = "OPEN" ] \
  || echo "DUP-WARN #$PR: issue #$ISSUE already closed — possible duplicate."

# (c) sibling PR closing the same issue
DUP_PRS=$(gh pr list --repo "$REPO" --state open --search "in:body \"Closes #$ISSUE\"" --json number -q 'length')
[ "${DUP_PRS:-1}" -le 1 ] \
  || echo "DUP-WARN #$PR: $DUP_PRS open PRs say 'Closes #$ISSUE' — reconcile before merging."
```
Any `DUP-WARN` → **do not merge**. Record it `blocked` with the warning as `blocking_reason`, carry it
to the handoff, and close the duplicate PR with a note rather than merging it. Merging a duplicate is
the one autonomous action that can't be undone cheaply.

## Merge

A PR that clears the checklist, has a clean review verdict, and green CI is merged **without asking** —
the user approved these merges when they launched the run. Print this as a log line, not a prompt:

```
PR #<N> — <title>  → MERGED (squash)
  Checks green: <every check in the rollup, named>
  Review rounds: <N> (reviewer: review-mesh <PASS|WARN>; code-quality comments: <N verified>)
  Tests: <db_set | db_unset — integration tests skipped locally, CI was the gate>
  Lint: <clean | N fixed>
  Unresolved findings: <none | N minor — filed as follow-up #<M>>
  Docs: <paths updated | none needed: reason>
  Ponytail: <clean|deferred: …>   ← only when the worker reported ponytail != n/a
```

```bash
gh pr merge "$PR" --squash
```
No `--delete-branch` — the repo auto-deletes on merge and the explicit flag fights branch protection.

Before merging, check the worker's `docs` claim against the diff: an observable change (new env var,
user-visible feature, deploy/security behavior, API/schema/CSV shape) with `none-needed` and no
convincing reason gets sent back for a docs commit on the same PR. Docs that land in a separate
follow-up issue are docs that never land, and `README.md` + `site/src/content/docs/index.mdx` are the
public pitch — stale claims there are worse than none.

Anything short of clean-and-green does **not** merge autonomously: unresolved important findings, or a
loop that exited on `MAX_ROUNDS` rather than clean. File the leftovers as a follow-up issue
(autonomous, no need to ask — same milestone, same `area:*` label, linked to the epic as a sub-issue
if it's in scope), mark the PR `blocked`, hand it off.

## After the merge

```bash
git worktree remove "../parley-wt-issue-$ISSUE"
git fetch --prune origin
```
Set the state-file `phase` to `merged` and the Project `Status` to **Done**:
```bash
ITEM=$(gh project item-list 1 --owner Lets-Parley --format json \
  | jq -r --argjson n "$ISSUE" '.items[] | select(.content.number == $n) | .id')
gh project item-edit --project-id PVT_kwDOEvhPCM4BguZt --id "$ITEM" \
  --field-id PVTSSF_lADOEvhPCM4BguZtzhfs26Q --single-select-option-id 4a6bdc79   # Done
```
Best-effort and non-fatal — a failed field edit never fails the run; re-resolve the ids with
`gh project field-list 1 --owner Lets-Parley --format json` if they've changed.

**Do not hand-edit the epic body.** Parley uses native sub-issues, so `Closes #<n>` closes the
sub-issue and GitHub updates the epic's sub-issue progress itself. There are no checkboxes to tick.

Only merged issues lose their worktree. A blocked or in-flight issue keeps it — deleting it turns a
resumable failure into an unresumable one.
