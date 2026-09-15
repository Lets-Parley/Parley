---
name: epic-worker
description: >-
  Deliver a single GitHub issue end-to-end — isolated worktree, TDD (red then
  green) against acceptance criteria, Conventional Commits, and an opened PR.
  Use when the user says "work issue #N", "pick up #N", "implement issue N",
  "do epic-worker on N", "knock out #1234", or when epic-worker-manager
  dispatches a worker for one sub-issue.
---

# Epic Worker (Parley) — Cursor

Deliver one issue. Isolated worktree, TDD, Conventional Commits, PR opened, summary reported.

**Announce at start:** "Using epic-worker to deliver issue #<N>."

## Cursor harness

Claude Code original; this is the Cursor port.

| Claude Code | Cursor |
|---|---|
| `Agent` (`Explore`, `general-purpose`) | `Task` (`subagent_type: "explore"` or `"generalPurpose"`) |
| `model: "haiku"` / `"sonnet"` / `"opus"` | `model: "cursor-grok-4.6-medium"` (Cursor Grok 4.6). If a newer Grok slug is on the Task allow-list, use that. Override only when the user names a different listed model |
| `Bash` | `Shell` (zsh — quote every expansion) |
| Slash skills (`/impeccable`, `/address-pr-review`) | **Read** `.cursor/skills/<name>/SKILL.md`, else `~/.cursor/skills/<name>/SKILL.md` |

Do not invent Claude `Agent` / `AskUserQuestion` calls.

## Inputs

- `ISSUE_NUMBER` (required) — if missing, ask. Don't guess.
- `BASE_BRANCH` (optional, default `main`)
- `WORKTREE_BRANCH` (optional, default derived from issue title — Step 3)
- `BASE_PULLED` / `WORKTREE` — when dispatched by `epic-worker-manager`, skip Steps 4–5 and work only in the given worktree with `git -C`.

## Hard rules (read before doing anything)

- **No AI attribution.** Never put `Co-Authored-By`, "Generated with …", or any AI mention in commits, PR title, PR body, branch name, code comments, or replies.
- **Conventional Commits** for every commit (`feat:`/`fix:`/`refactor:`/`test:`/`chore:`/`docs:`), scoped like this repo (`fix(hub):`, `feat(web):`). No release-please here — readable history only.
- **TDD:** failing test first, watch it fail, then minimum change to pass. Behavioural changes need a test on both sides of the stack when they touch Go and `web/`.
- **Never `--no-verify`.** Fix the hook failure, don't bypass it.
- **Never `git push --force`** without explicit user say-so.
- **Stay in the worktree** — never run destructive commands against the user's main checkout. Never `git stash` (stash is global to the repo).
- **Shell hygiene.** The Shell tool runs **zsh** — quote every expansion (`"$ISSUE"`, `"$BASE_BRANCH"`) and never iterate unquoted command output.

## Parley build and test (every worker)

- `cd web && npm ci && npm run build` is **required** before any `go build` or `go test`. `web/embed.go` embeds `web/dist`; a fresh worktree has no `dist`.
- `go vet ./...` then `go test -p 1 -race ./...`. **`-p 1` is mandatory.**
- Never report a green Go run without saying whether `TEST_DATABASE_URL` was set. Without it, integration tests fail rather than skip unless `PARLEY_SKIP_DB_TESTS=1` (do not set that).
- Frontend: `cd web && npm test` and `npm run lint` (oxlint — CI does not run lint).
- Migrations in `internal/db/migrations/` are **append-only**. Never edit or renumber a shipped file.
- Docs for user/operator-visible changes land in the **same PR** (see the dispatch table in `epic-worker-manager/references/dispatch.md` if present). Never edit `ROADMAP.md`.

## Workflow

### 1. Prep

```bash
ISSUE=<ISSUE_NUMBER>
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh auth status >/dev/null
gh issue view "$ISSUE" --json number,title,body,labels,assignees,url,milestone,projectItems
```

From the body extract: acceptance criteria, parent epic (native parent / Feature issue), files named, out-of-scope notes. **If AC are missing or ambiguous, stop and ask.**

### 2. Claim the issue (duplicate-work guard)

```bash
OPEN_PR=$(gh pr list --repo "$REPO" --state open --search "in:body \"Closes #$ISSUE\"" --json number -q '.[0].number // ""')
OWNER_LOGIN=$(gh issue view "$ISSUE" --json assignees -q '.assignees[0].login // ""')
if [ -n "$OPEN_PR" ]; then
  echo "STOP: PR #$OPEN_PR already closes issue #$ISSUE — likely in flight."
elif [ -n "$OWNER_LOGIN" ] && [ "$OWNER_LOGIN" != "$(gh api user -q .login)" ]; then
  echo "STOP: issue #$ISSUE already assigned to $OWNER_LOGIN."
else
  gh issue edit "$ISSUE" --add-assignee "@me"
fi
```

If either STOP fires, surface it and wait.

### 3. Pick a branch name

- Type prefix from labels / title: `feat/`, `fix/`, `refactor/`, `chore/` (AGENTS.md: `type/kebab-slug`).
- Slug: lowercase title, alphanumerics + hyphens, max 40 chars. Suffix with the issue number.
- Example: 3811 "Add plugin fetch timeout" → `feat/3811-plugin-fetch-timeout`.
- **Forbidden prefixes:** `claude/`, `ai/`, `assistant/`, `bot/`, `cursor/`.

When the manager already created `issue-<N>`, use that branch — do not rename it.

### 4. Pre-flight on `BASE_BRANCH`

**Skip if `BASE_PULLED=true`.** Otherwise, from the **primary checkout**:

```bash
git fetch origin
git checkout "${BASE_BRANCH:-main}"
git pull --ff-only
```

If `--ff-only` won't fast-forward, **stop and ask**.

### 5. Create the worktree

**Skip if `WORKTREE` is already set** (manager created it). Otherwise invoke **using-git-worktrees** with the branch name and `BASE_BRANCH`. If baseline tests fail, stop. Then work only from the worktree — verify with `git rev-parse --show-toplevel`. Pass `git -C <ABS_PATH>` if a chained `cd` may not stick.

### 6. Research (token-budgeted)

This repo has no code graph. **Full procedure: read `references/research.md`.** Then write a brief plan (behavior change, smallest proving test, files to touch, out-of-scope). If the issue is really two, surface it.

### 6b. UI work → design context

If the work is UI-facing **and** `impeccable` is installed, load design context before writing UI code. **Gate: `references/quality-passes.md` §6b.** Not installed → skip silently. Parley tokens live in `web/src/tokens.css`.

### 7. TDD — RED

Write the failing test(s) first at the layer that most directly proves the AC. Run it and **confirm it fails for the right reason**. If it passes immediately, the test is too weak.

```bash
go test -p 1 -race ./internal/foo/ -run TestY
cd web && npm test -- src/components/Foo.test.tsx
```

Optionally commit the failing tests (`references/commit-pr-templates.md`).

### 8. TDD — GREEN

Minimum code to pass. YAGNI. If `ponytail` is installed, hold its ladder yourself (session hooks do not reach `Task` subagents). **Never trim:** trust-boundary validation, data-loss handling, security, accessibility, your TDD test.

Rebuild `web/dist` before Go tests. Run new tests to green, then the **full** suite (`go test -p 1 -race ./...` with `TEST_DATABASE_URL`, `cd web && npm test && npm run lint`). Commit via the GREEN template.

### 9. Refactor (only if needed)

Separate `refactor:` commit, suite green at every step. Skip if already clean.

### 10. Verification before push

```bash
cd web && npm run lint && npm test
go vet ./...
go test -p 1 -race ./...
git diff "$BASE_BRANCH"...HEAD
git log "$BASE_BRANCH"..HEAD --oneline
```

Check for leftover debug prints, TODOs without tickets, AI-flavored comments, commented-out code, unrelated reformatting, edited shipped migrations.

### 10b–10d. Optional pre-push passes (`references/quality-passes.md`)

Each skips silently if its skill/CLI/MCP is absent.

- **§10b SonarQube** — Parley has none; skip.
- **§10c Impeccable** — only if §6b loaded design context.
- **§10d ponytail-review** — if installed; fold cheap behavior-preserving cuts; never delete the TDD test.

### 11. Push and open PR

```bash
git push -u origin "$(git branch --show-current)"
EXISTING_PR=$(gh pr list --repo "$REPO" --state open --search "in:body \"Closes #$ISSUE\"" --json number -q '.[0].number // ""')
[ -z "$EXISTING_PR" ] || echo "STOP: PR #$EXISTING_PR already closes #$ISSUE."
```

Open the PR — Conventional Commit title, `Closes #<ISSUE>`, **no AI attribution**. Template: `references/commit-pr-templates.md`.

### 12. Review

Cursor Bugbot auto-runs on PR open. **Do not request Copilot** (not used here). Then:

- **Dispatched by `epic-worker-manager`:** report and stop. The manager owns review, Bugbot threads, CI, merge.
- **Standalone:** tell the user the PR is open and Bugbot is running. If `address-pr-review` is installed, hand off once findings land. Do not sleep-poll.

### 13. Report

```
Issue:    #<ISSUE> — <title>
Branch:   <branch-name>
Worktree: <path>
PR:       <PR URL>  (#<PR number>)
Commits:  <count> — <conventional subjects, comma-separated>
Tests:    <N new>, full suite <green|partial> (TEST_DATABASE_URL <set|unset>)
Lint:     <clean|failing>
Docs:     <updated:paths | none-needed:why>
CI:       triggered (waiting)
Ponytail: <clean | deferred:… | skipped:… | n/a>
Notes:    <deferred AC, surprises, follow-ups>
```

When dispatched, emit the manager's `WORKER_REPORT` block instead if the prompt asked for it.

## Failure modes

| Situation | Action |
|---|---|
| Acceptance criteria ambiguous | Stop, ask. |
| `BASE_BRANCH` won't fast-forward | Stop, ask. |
| Baseline tests fail in worktree | Stop, report, ask. |
| Hook fails on commit | Fix, re-stage, **new** commit. Never `--amend` after a hook failure. Never `--no-verify`. |
| Issue scope exceeds plan | Surface — don't silently expand. |
| Tests can only pass with broad refactor | Ask whether to split prep + feature PRs. |
| Need to edit a shipped migration | Stop. Append-only. |
| `pattern all:dist: no matching files found` | Rebuild `web/dist`. |
| You catch yourself writing "Co-Authored-By" / "Generated with" | Delete it. |

## Integration

- **Calls:** `using-git-worktrees` (standalone only), `test-driven-development` if installed, `impeccable` / `ponytail-review` when present.
- **Called by:** `epic-worker-manager` (one per issue), or the user.
- **Hands off to:** the manager's review loop when dispatched; the user / `address-pr-review` when standalone.

## Additional resources

- [references/research.md](references/research.md)
- [references/commit-pr-templates.md](references/commit-pr-templates.md)
- [references/quality-passes.md](references/quality-passes.md)
