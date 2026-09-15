# Durable state + handoff

## Why a state file

The manager's own process is the least reliable component in this pipeline. An API 500/529, a killed
terminal, a context compaction — any of them ends the run mid-epic, and everything the manager "knew"
(which issue maps to which worktree, which PR is on review round 3, which issue is blocked and why)
evaporates. GitHub holds most of the truth but not the *bookkeeping*: it can't tell you a PR is on its
third failed fix attempt, or that #48 was deliberately parked.

So: **written after every transition, read first on every start.** A crash costs one `jq` read.

## Location and schema

`.claude/epic-state.<EPIC>.json` in the primary checkout — e.g. `.claude/epic-state.47.json`. `.claude/`
is ignored by the user's global gitignore (`**/.claude/`), so nothing needs adding to `.gitignore`
and the file can never land in a PR. **Keep this path** even when the manager is running under Cursor
— Claude Code and Cursor share the same bookkeeping so either harness can resume the other.

**The filename carries the epic number.** A single fixed `epic-state.json` is a shared mutable path,
and this checkout runs concurrent sessions: a sibling manager on a different epic would find a
"mismatched" file and overwrite the bookkeeping of a run still in flight.

**Check for a sibling manager before starting.** Any other `.claude/epic-state.*.json` whose issues
aren't all `merged`/`blocked` means another session is live here. Not automatically a stop — two epics
in different areas coexist fine — but report it, and treat every `.claude/` path that isn't yours as
read-only: don't archive, delete, or tidy their file, worktrees, or stash entries.

**The same epic in two sessions is the case this filename cannot catch,** because both sessions
compute the identical `epic-state.<EPIC>.json` and the identical `../parley-wt-issue-<N>` paths. The
second one then reads the first one's live file as its own stale state. Do not try to settle this
from the file: it is self-describing, and a session that crashed leaves bookkeeping indistinguishable
from a session that is busy. **Settle it with git** — SKILL.md Step 0's liveness test (`git -C
<worktree> status --porcelain` over every recorded worktree, plus `last_checkpoint` against the
branch). Dirty tree means a live worker; clean and quiet means the run is dead and yours to resume.
This has already cost a worker its uncommitted output once.

```json
{
  "epic": 47,
  "epic_title": "feat: a room everyone can actually use — accessible live rooms",
  "milestone": "v0.3.0",
  "base_branch": "main",
  "started": "2026-08-18T14:02:11Z",
  "stash_ref": null,
  "test_db_set": true,
  "issues": [
    {
      "issue": 48,
      "worktree": "../parley-wt-issue-48",
      "branch": "issue-48",
      "pr": 57,
      "phase": "awaiting_ci",
      "review_rounds": 2,
      "fix_attempts": 1,
      "last_checkpoint": "2026-08-18T15:40:03Z",
      "blocking_reason": null
    }
  ]
}
```

`phase` per issue: `dispatched` → `in_review` → `fixing` → `awaiting_ci` → `merged`, plus the terminal
`blocked`. `fix_attempts` counts *consecutive failed* attempts and resets to 0 on any success — it's
the counter the autonomy boundary trips on at 3. `test_db_set` records whether `TEST_DATABASE_URL` was
available, because it changes what a green local test run means and belongs in the handoff.

## Writing a transition

One `jq` read-modify-write, in a single shell function so no code path forgets:

```bash
STATE=".claude/epic-state.${EPIC}.json"

set_issue() {  # set_issue <issue> <key> <json-value>
  local tmp; tmp=$(mktemp)
  jq --argjson i "$1" --arg k "$2" --argjson v "$3" \
     '(.issues[] | select(.issue == $i)) |= (.[$k] = $v | .last_checkpoint = (now | todate))' \
     "$STATE" > "$tmp" && mv "$tmp" "$STATE"
}

set_issue 48 phase '"awaiting_ci"'
set_issue 48 pr 57
set_issue 48 blocking_reason '"CI red 3x on the same test — needs human"'
```
`mktemp` + `mv`, never in-place: a crash mid-write must not leave a truncated state file, which is
strictly worse than none.

## Resuming

If `$STATE` exists and its `epic` matches, **resume rather than restart**. Reconcile each issue against
live GitHub first — the file records what the manager last saw, which may be days stale:

| Recorded `phase` | Reconcile | Then |
|---|---|---|
| `dispatched`, no `pr` | `gh pr list --search "in:body \"Closes #<issue>\""` | PR exists → jump to `in_review`; none → check the worktree; branch has commits → resume it, else re-dispatch |
| `in_review` / `fixing` | re-read the PR's reviews + inline comments | continue at the recorded `review_rounds`; don't reset the counter, and don't re-run `review-mesh` if it already ran on this PR |
| `awaiting_ci` | `gh pr checks "$PR"` | green → merge path; red → `fixing` (`fix_attempts + 1`) |
| `merged` | `gh pr view "$PR" --json state` | confirm `MERGED`; if `OPEN`, the merge never landed → back to `awaiting_ci` |
| `blocked` | — | leave blocked; it's already in the handoff |

Report the resume in one line before anything else:
`Resumed epic #47 — 2 merged, 1 awaiting_ci (PR #57), 1 blocked (#51).`

A state file for a *different* epic is not yours and not an error. Leave it alone. Archive your own
only after every issue reaches `merged`/`blocked` and the handoff is written.

## Handoff document

Written to `~/.cursor/projects/home-jacorbello-repos-parley/handoffs/epic-<EPIC>.md` — **outside the
repo**, so it can never end up in a PR (`docs/` in this repo is images, not prose). If a Claude Code
handoff already exists at
`~/.claude/projects/-home-jacorbello-repos-parley/handoffs/epic-<EPIC>.md`, prefer updating the
Cursor path going forward and mention the old path once in the handoff so nothing is orphaned. If the
file already exists from an earlier run, update it in place rather than writing a second one. The
audience is a human with zero context: lead with what they must do.

```markdown
# Epic #47 — feat: a room everyone can actually use
_2026-08-18T21:14:00Z · run started 2026-08-18T14:02:11Z · milestone v0.3.0_

## Next command
```
epic-worker-manager 47
```

## Merged
- #48 — feat(web): text equivalents for every seat and the revealed result → PR #57 (squashed abc1234)
- #49 — feat(web): the standup rail says whose turn it is → PR #58 (squashed def5678)

## Blocked — needs a human
- #50 — **why:** third consecutive fix attempt failed; `MemberCard.test.tsx:76-83` asserts the
  backdrop-click behaviour that moving to the native `<dialog>` deliberately removes.
  **What a human must decide:** whether that regression is accepted (epic body says it is) or the
  dialog needs a close-button slot first. **State:** worktree `../parley-wt-issue-50` left in place,
  branch `issue-50`, PR #59 open, CI green, review clean.

## Human-only work (labeled `help wanted`)
- none

## Still in flight
- #51 awaiting CI (PR #60) — supervisor loop will resume it.

## Caveats from this run
- `TEST_DATABASE_URL` was not set locally, so every worker's integration tests skipped; CI was the
  only real gate on the Go side.
- 3 `github-code-quality[bot]` comments on PR #57 were verified as false positives (flagged a
  deliberate re-export).
```

Keep the worktree for anything blocked or in flight — deleting it is how a resumable failure becomes
an unresumable one.

## Final report block

Print after the handoff:
```
Epic #<N> — <title>
  Sub-issues: <N total>
  Merged:     <M> (PRs <list>)
  Held:       <K> (PRs <list> — reason)
  Blocked:    <F> (issues <list> — needs human)
  Tests:      <TEST_DATABASE_URL set | UNSET — integration tests skipped locally>
  Handoff:    ~/.cursor/projects/home-jacorbello-repos-parley/handoffs/epic-<N>.md
  Duration:   <H>h <M>m wall-clock
```
