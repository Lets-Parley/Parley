---
name: epic-completion
description: >-
  Verify a Parley epic is actually finished after epic-worker-manager or
  epic-worker has shipped its sub-issues — pulls the Feature tracking issue and
  every native sub-issue plus merged PRs, audits acceptance criteria, runs
  security and performance review on the cumulative diff, checks user-facing
  docs, and converts gaps into confirmed follow-up sub-issues. Use when the user
  says "wrap up <epic>", "finalize <epic>", "is the <epic> epic done?",
  "audit <epic>", "epic-completion <epic>", "close out <epic>", "verify <epic>
  is shipped", or "let's call <epic> done".
---

# Epic Completion (Parley) — Cursor

Final-pass audit on a Feature epic. Reads the tracker + every sub-issue + every merged PR, finds the gaps, and turns them into new follow-up **native sub-issues**. Does not write application code.

**Announce at start:** "Using epic-completion to audit `#<N>` / `<title>`."

## Cursor harness

Claude Code original; this is the Cursor + Parley port.

| Claude Code | Cursor |
|---|---|
| `Agent` (`general-purpose`) | `Task` (`subagent_type: "generalPurpose"`) |
| `model: "sonnet"` / `"opus"` | `model: "cursor-grok-4.6-medium"` (Cursor Grok 4.6). If a newer Grok slug is on the Task allow-list, use that. Override only when the user names a different listed model. For the security pass, prefer `subagent_type: "security-review"` if the session exposes it (still pass the Grok model) |
| Slash `/epic-worker-manager` | Read `.cursor/skills/epic-worker-manager/SKILL.md` |
| `~/.claude/CLAUDE.md` | `AGENTS.md` in this repo |
| `type:epic` + `phase:N` labels | **Parley uses native issue type `Feature` and native sub-issues.** There is no `type:epic` or `phase:N` |

Do not invent Claude `Agent` calls. Ask in the conversation and wait — no `AskUserQuestion`.

## When to use this vs. epic-worker-manager

- `epic-worker-manager` *delivers* sub-issues. Foreman during construction.
- `epic-completion` *verifies* the whole epic. Inspector after construction. It writes follow-up work, not code.

Mid-epic ("ship the next batch") → manager. End ("is this done?", "wrap up #47") → this skill.

## Inputs

- `EPIC` (required) — Feature tracking issue number, or enough of its title to identify it.
- `BASE_BRANCH` (optional, default `main`).
- `INCLUDE_OPEN_PRS` (optional, default `false`) — if true, treat still-open PRs as in-flight and exclude them from the audit instead of failing the epic on them.

## Hard rules

- **No AI attribution** in issue bodies, comments, or tracker edits.
- **No silent edits to the Feature body.** Parley tracking is native sub-issues; GitHub updates progress itself. If you must add a comment summarizing the audit, show the text first. Do not invent phase headings on the tracker.
- **A new issue is not filed until it is wired** — milestone (if the epic has one), native sub-issue link to the Feature, Parley Roadmap project, board Status. A bullet in a comment is a note, not tracking.
- **No new issues without confirmation.** Present the gap list first.
- **Read-only on the codebase.** Code fixes belong to a later `epic-worker-manager` run on the new sub-issues.
- **Conventional Commits** in follow-up titles so a future worker run can pick them up.

## Workflow

### 1. Pre-flight

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER=${REPO%/*}; NAME=${REPO#*/}

git fetch origin
git checkout "${BASE_BRANCH:-main}"
git pull --ff-only
gh auth status >/dev/null
mkdir -p /tmp/epic-completion
```

If `git pull --ff-only` won't fast-forward, stop and ask.

### 2. Find the tracking epic

Same GraphQL as the manager — issue type must be `Feature`:

```bash
gh api graphql -f query='
query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){
  issue(number:$n){number title url state body issueType{name} milestone{title}
    labels(first:20){nodes{name}}
    projectItems(first:5){nodes{project{number title id}}}
    subIssues(first:100){totalCount nodes{number title url state stateReason body
      issueType{name} milestone{title} closedAt
      labels(first:20){nodes{name}}
      timelineItems(first:50,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT,CLOSED_EVENT]){
        nodes{
          __typename
          ... on CrossReferencedEvent {
            source { __typename ... on PullRequest { number state isDraft merged mergedAt url title baseRefName } }
          }
          ... on ClosedEvent { stateReason }
        }}}}}}' \
  -F owner="$OWNER" -F name="$NAME" -F n="$EPIC"
```

If the number wasn't given, search open Feature issues by title; ask on 2+ matches. If `issueType.name != "Feature"`, say so and ask.

Read the body: **Baseline**, **Scope**, **Out of scope**, **Constraints**, **Acceptance criteria**. Extract AC bullets literally. Out-of-scope notes are not gaps. If there is no AC, ask where it lives or to waive AC grading — don't fabricate it.

### 2.5 Identify the audit boundary

Long-running epics get audited more than once. Scan existing sub-issue titles/bodies for a prior completion pass (`Completion follow-up`, `epic-completion`, `audit gaps`).

- **AUDIT_BOUNDARY** = those already-filed follow-up sub-issues (and anything they closed).
- **Scope of this run** = original epic sub-issues plus any prior-audit AC still Missing, excluding work that only exists to satisfy an already-shipped follow-up that you are not re-grading.
- **Cumulative diff** for Section 5 anchors at the parent of the *oldest* merged PR among in-scope sub-issues. First-pass: oldest merged PR in the whole epic.

Tell the user the scoping decision in one line. Don't silently re-grade or silently skip.

### 3. Bucket every sub-issue + its PRs

From `subIssues.nodes` (include closed). Keep linked PRs whose `baseRefName == BASE_BRANCH` and `merged == true` (or `state == OPEN` if `INCLUDE_OPEN_PRS`).

| Bucket | Treatment |
|---|---|
| Closed + has merged PR(s) | AC verification (Section 4.1) |
| Closed as `NOT_PLANNED` | Note, don't grade |
| Closed, no merged PR | Suspicious — flag as gap |
| Open | Not done — flag, unless `INCLUDE_OPEN_PRS` |

Zero sub-issues → ask. Quote GraphQL/API URLs so zsh does not glob `?`.

### 4. Audit

Default: one `Task` (`generalPurpose`, Cursor Grok 4.6) per in-scope closed+merged issue when there are 3+ such issues. Bundle issue body, extracted AC, and PR numbers so the subagent does not re-fetch. It may `gh pr diff` itself. Inline for 1–2 issues.

**Short-circuit issues with no gradable AC** — verdict "no AC to grade"; don't spawn a subagent.

#### 4.1 Per-issue AC

For each closed + merged PR issue in scope:

1. Extract that issue's AC.
2. `gh pr diff "$PR" --patch` and `gh pr view "$PR" --json title,body,files,commits,additions,deletions`.
3. Grade each bullet **Met / Partial / Missing / Out of scope** with a file:line cite.
4. Note diff that is not tied to any AC (feature creep).

Verdict: **Pass** (all Met or Out-of-scope), **Partial** (any Partial/Missing), **Fail** (≥ half Missing).

#### 4.2 Epic-level AC

For each tracker AC, decide whether some combination of merged PRs satisfies it. Don't trust checkboxes — trust diffs.

#### 4.3 Suspicious closures

List issues closed without a merged PR and not `NOT_PLANNED`. Don't auto-create follow-ups — ask.

### 5. Cross-cutting reviews

#### 5.1 Security

```bash
ANCHOR_SHA=$(gh pr view "$OLDEST_PR" --json mergeCommit --jq '.mergeCommit.oid')^
git diff "$ANCHOR_SHA"..origin/"$BASE_BRANCH" -- ':(exclude)*.lock' ':(exclude)package-lock.json' > /tmp/epic-completion/cumulative.patch
```

If the patch is 50k+ lines, you probably ignored AUDIT_BOUNDARY; re-check before falling back to targeted file reads.

Prefer Cursor `Task` `subagent_type: "security-review"` on the cumulative diff / PR set. If that type isn't available, `generalPurpose` with this prompt. Either way set `model: "cursor-grok-4.6-medium"` (Cursor Grok 4.6):

```
You are reviewing the cumulative diff of epic #<EPIC> on <REPO>.
The diff is at /tmp/epic-completion/cumulative.patch.

Surface only real, exploitable, or high-likelihood issues. For each:
- Severity: critical | high | medium | low
- File:line range
- What the issue is, in one sentence
- Why it's exploitable
- Suggested remediation, one sentence

Pay attention to: new routes (authz, validation), secrets/env, SQL, uploads,
permission checks, CSP/CORS/cookie flags, plugin sandbox / capability grants,
signed-link guest routes, TRUST_PROXY_HEADERS, BASE_URL.

Return a JSON array, empty if nothing material. Do not invent findings.
```

#### 5.2 Performance / cost

Same diff. `Task` `generalPurpose` with `model: "cursor-grok-4.6-medium"`:

```
Review the cumulative diff of epic #<EPIC> on <REPO> for performance/cost.

Look for: sync I/O on hot paths, N+1, unbounded loops, new jobs, missing
indexes, caches removed, extra DB roundtrips, websocket fan-out work that
should stay in Postgres.

For each: file:line, regression, order-of-magnitude impact, fix suggestion.
Empty array if nothing material.
```

#### 5.3 Documentation

User-visible change → owning surface in `site/` (and `.env.example` / `AGENTS.md` / `SECURITY.md` when those rules apply). Heuristics:

- New route / env / flag → configuration docs + `.env.example`
- User-facing UI → `site/src/content/docs/features/`
- Auth/authz/redaction → `site/src/content/docs/security/`
- Schema / API / CSV → `site/src/content/docs/reference/`
- Docs pages with a `VerifiedStamp` must have the stamp updated in the same change (that's a follow-up for a worker, not this skill's job to edit).

Don't fabricate doc gaps for internal refactors. Output `(PR #, missing-doc location, what should be added)`.

### 6. Compile the gap report

```
Epic completion audit — #<EPIC> <title> on <REPO>
  Tracker: #<N> (<URL>)  type: Feature
  Sub-issues: <total>  (merged:<M>  closed-no-PR:<X>  open:<O>  not-planned:<NP>)
  PRs: <merged> merged into <BASE_BRANCH>
  Lines: +<add> / -<del>  across <files> files

Epic-level acceptance criteria:
  ✅ Met / 🟡 Partial / ❌ Missing  (cite issue + PR)

Issues with partial / failed AC:
  - #<N> <title> — <which bullets>

Suspicious closures:
  - #<N> <title>

Security / performance / documentation findings:
  - …
```

### 7. Confirm with the user

```
Found <total> potential gaps.

Proposed follow-up sub-issues:
  1. fix(<scope>): <gap title>     labels: <existing area:*>
  2. docs(<scope>): document <feature>
  …

Create these <K> as native sub-issues of #<EPIC>, same milestone, Parley Roadmap?
You can also: (a) edit the list, (b) drop items, (c) report-only, (d) abort.
```

Wait. Auto mode does **not** override this confirmation — these are public artifacts.

### 8. Labels and titles

Discover labels from the epic's existing sub-issues and **mirror** them (`area:core` / `area:web` / `area:db` / `area:plugins` plus stock types). Do not create `phase:N` or `type:epic`. Map gaps:

| Gap source | Title intent |
|---|---|
| Missing/Partial AC | `fix` if regression-flavored, else `feat` |
| Security | `fix` / security-flavored title; `priority` only if the epic already uses that label |
| Performance | `perf` |
| Documentation | `docs` |

### 9. Create follow-up issues (after confirmation)

```bash
gh issue create \
  --title "<conventional-style title>" \
  --body "$(cat <<'EOF'
## Context
Surfaced during epic-completion audit of #<TRACKER>.

## Acceptance criteria
- [ ] <bullet 1>
- [ ] <bullet 2>

## Source
- Epic: #<TRACKER>
- Originating finding: <security|perf|docs|AC gap>
- Related PR: #<PR>  (if applicable)
EOF
)" \
  --label "<mirrored labels>"
```

#### 9.5 Wire every new issue — all four, every time

**1 — Milestone** if the Feature has one:

```bash
gh issue edit "$NEW" --milestone "$MILESTONE_TITLE"
```

**2 — Native sub-issue of the tracker** (GraphQL `addSubIssue`). A `#` mention is not enough.

**3 — Project board** the tracker is already on (`gh project item-add`). Parley Roadmap is `--owner Lets-Parley` number `1` when that is where the tracker lives — do not guess a different board.

**4 — Board fields.** Mirror siblings; Status for a new follow-up is **Todo** (or the board's equivalent of not-started — **not** Done). Re-resolve field IDs with `gh project field-list` rather than hard-coding if an edit fails.

Backfill prior audit follow-ups missing any of the four. If the repo has no project, skip 3–4 and say so.

### 10. Audit comment on the tracker (optional, confirmed)

Do **not** rewrite the Feature body to add a phase section. After wiring, offer a single issue comment with the audit summary and the new sub-issue numbers. Show the comment text; wait; then `gh issue comment`.

### 11. Final report

```
Epic completion: #<EPIC> — <title>
  Audit verdict:
    Acceptance criteria: <met>/<total>  (partial:<P>  missing:<M>)
    Security findings:   <count>
    Performance:         <count>
    Documentation:       <count>
  Created sub-issues:
    #<a> — <title>
    …
  Board wiring: <K> issues on <board>, milestone <M>, sub-issues of #<EPIC>
  Next step: epic-worker-manager <EPIC>
```

Zero gaps → recommend closing the Feature. Don't manufacture tickets.

## Failure modes

| Situation | Action |
|---|---|
| `main` won't fast-forward | Stop, ask. |
| Tracker isn't type Feature / ambiguous | Ask. |
| No acceptance criteria | Ask where AC lives or waive. |
| Closed with no PR, not `NOT_PLANNED` | List; don't auto-file. |
| Cumulative diff >50k lines | Targeted file reads, not one patch. |
| Security agent returns dozens of findings | Default the gap report to critical/high; offer the rest. |
| New issue created but not a sub-issue / not on the board | Not done — finish Section 9.5. |
| No project board | Skip board steps; say so. |
| User says report-only | Stop after Section 6. |
| "Generated with" / `Co-Authored-By` | Strip it. |

## Integration

- **Calls:** optional Cursor `security-review` Task; else `generalPurpose` Tasks for AC / security / perf. Reads `gh` only — does not run workers.
- **Called by:** the user, typically after `epic-worker-manager` shipped what they thought was the last batch.
- **Hands off to:** `epic-worker-manager <EPIC>` to deliver the new sub-issues.
- **State:** GitHub (Feature, sub-issues, PRs, project). Mutating steps are gated on confirmation.
