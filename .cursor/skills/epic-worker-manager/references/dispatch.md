# Step 5 — Dispatch workers (Cursor)

One `Task` per issue **in the same assistant message** per batch (parallel).
`subagent_type: "generalPurpose"` — `epic-worker` is a **skill inlined into the prompt below**,
NOT a Task subagent type (passing it errors). Set **`model: "cursor-grok-4.6-medium"`** (Cursor Grok
4.6). If a newer Grok slug is on the Task allow-list, use that instead. Override only when the user
names a different listed model. The worker does TDD and real implementation. Wait for the batch to
finish before starting the next.

Each prompt is self-contained — the subagent has no conversation history and no prior tool results.
Bundle what you already fetched (issue body from Step 3, epic Constraints/Scope from Step 2, scope
set from Step 4). Pass absolute worktree paths; tell the worker to use `git -C` everywhere.

```
You are running the epic-worker skill on the Parley repo (Cursor Task).

Repo: Lets-Parley/Parley
Issue: #<NUMBER> (<URL>)  — sub-issue of epic #<EPIC> (<EPIC_TITLE>)
Base branch: <BASE_BRANCH>
BASE_PULLED: true   # Manager already fetched/pulled the base — skip epic-worker's pre-flight pull.

WORKTREE: <ABS_PATH>       # Already created by the manager off origin/<BASE_BRANCH>.
BRANCH:   issue-<NUMBER>   # Already checked out there.
# Do NOT create a worktree, do NOT run using-git-worktrees, do NOT switch branches, and do
# NOT touch the primary checkout. Work only inside WORKTREE and pass it explicitly on every
# git call: `git -C <ABS_PATH> …` — a chained `cd` does not reliably stick between tool
# calls, and one stray command in the primary checkout corrupts a sibling worker's run.
#
# NEVER run `git stash` (or stash pop/apply) anywhere. The stash stack is shared across every
# worktree in this repo, so your pop can destroy a parallel worker's changes. Inside your own
# worktree you never need it: commit or discard.
#
# SCRATCHPAD: <SCRATCHPAD>/issue-<NUMBER>/ — create it and keep every temp file inside. The
# scratchpad root is shared with sibling workers; a file named notes.md or out.json there gets
# clobbered mid-run by someone else's identically-named file.

Issue body (already fetched — do NOT re-run `gh issue view` unless you need a field not here):
<<<
title: <ISSUE_TITLE>
type: <Task|Bug|Feature>   labels: <comma-separated>   milestone: <TITLE or none>
body:
<ISSUE_BODY_VERBATIM>
>>>

Acceptance criteria (extracted by the manager — verify, don't re-extract):
- <AC 1>
- <AC 2>

Epic context (from #<EPIC> — use this, don't re-fetch):
<<<
Scope for this issue: <2-4 lines>
Out of scope: <1-2 lines>
Constraints (verbatim from the epic body — these are verified traps, not suggestions):
<CONSTRAINTS SECTION VERBATIM>
>>>

Likely files in scope (from partition analysis — start here, expand only if needed):
<scope_set paths>

## Parley build and test rules — all of these have shipped defects when skipped

- `cd web && npm ci && npm run build` is REQUIRED before any `go build` or `go test`. `web/embed.go`
  declares `//go:embed all:dist` and nothing under `web/dist/` is tracked, so a fresh worktree has no
  dist directory and Go compilation fails with `pattern all:dist: no matching files found`. A stale
  dist compiles fine while silently serving an old UI — rebuild when in doubt.
- Tests: `go vet ./...` then `go test -p 1 -race ./...`. **`-p 1` is mandatory** — every package
  shares one test database and migrates it.
- `export TEST_DATABASE_URL=…` or the integration tests silently `t.Skip`. **Never report a passing
  test run without saying whether the database was set.**
- Frontend: `cd web && npm test` (Vitest + jsdom + Testing Library) and `npm run lint` (oxlint).
  **CI does not run the lint — you must.** Tests sit beside their subject as `*.test.tsx`;
  `src/test/render.tsx` supplies the providers every screen assumes. No jest-dom matchers.
- Migrations in `internal/db/migrations/` are **append-only** and versioned by filename prefix. Add a
  new file; never edit or renumber a shipped one. If your issue seems to require editing one, stop
  and report it rather than doing it.
- Go style: `gofmt`, `go vet` clean, wrapped errors (`fmt.Errorf("reading foo: %w", err)`), literal
  JSON error bodies in handlers with lowercase human messages, `log/slog` JSON logging. No
  golangci-lint config — don't add one as a drive-by.
- Frontend style: TypeScript strict, PascalCase components in `web/src/components/`, pages in
  `web/src/pages/`, helpers in `web/src/lib/`, design tokens in `web/src/tokens.css`.
- A `StateFunc` must return only redacted, client-safe data — it is broadcast to every participant.

## Documentation is part of the change, not a follow-up

Parley is a public product: a feature nobody can find in the docs shipped half-done. If your diff
changes anything a user, operator, or contributor can observe, update the owning surface **in the same
PR** — a docs-only follow-up issue is the failure mode, not the plan.

| What you changed | Surface to update |
|---|---|
| Env var, flag, default, limit | `.env.example` **and** `site/src/content/docs/reference/configuration.mdx` (or `limits-and-defaults.mdx`) |
| User-facing feature or flow | `site/src/content/docs/features/<kind>.mdx`; a brand-new session kind also needs its own page linked from `features/index.mdx` |
| Anything a first-time user sees | `README.md` (the pitch + feature list) and `site/src/content/docs/index.mdx` — these are the marketing surfaces; keep the claims true and the tone matching what's already there |
| Deploy, scaling, backup, upgrade behavior | `site/src/content/docs/operations/`, `deploy/k8s/`, `docker-compose.yml` if it drifts |
| Auth, authz, redaction, cookie/CSP/CORS behavior | `site/src/content/docs/security/` and `SECURITY.md` when the disclosure or guarantee changes |
| API/WS envelope, DB schema, CSV export | `site/src/content/docs/reference/api.mdx` / `database-schema.mdx` / `csv-format.mdx` |
| A known trap you couldn't fix | `site/src/content/docs/known-limitations.mdx` |
| Frontend dev workflow or build step | `web/README.md` |
| A new invariant or gotcha another agent would trip on | `AGENTS.md` |

Rules that keep this cheap: never touch `ROADMAP.md` (strategic prose, owned by the humans), don't
write docs for an internal refactor nobody can observe, and don't paste your PR description into a
docs page — write the sentence a user needs. Touching `site/**` adds the path-filtered `site` CI check
to your PR; that's expected, let it run. If a surface genuinely doesn't need updating, say so in the
`docs` report field with the reason rather than leaving it blank.

## Hard rules (no exceptions)

- Work only in the WORKTREE (`git -C <ABS_PATH> …`). No new worktree, no `git stash`, no writes outside it.
- TDD: a failing test first, **seen to fail**, then the minimum implementation. Behavioural changes
  need a test on both sides of the stack — every defect this project has shipped in `web/` passed a
  green build.
- Conventional Commits on every commit (`feat:`/`fix:`/`refactor:`/`test:`/`chore:`), scoped like the
  repo does it (`fix(hub):`, `feat(web):`, `feat(db,api):`).
- NO AI ATTRIBUTION. No `Co-Authored-By`, no "Generated with …", no AI mentions in code comments, PR
  body, or branch names. Parley is a public repo; sweep your diff before committing.
- Never `--no-verify`. Fix hook failures, don't bypass them.
- Open the PR with a Conventional-Commit title and `Closes #<NUMBER>` in the body.
- **Override epic-worker step 12.** Parley has no Copilot review and no SonarQube (so epic-worker
  §10b has nothing to call). Cursor Bugbot **is** active and runs itself on PR open — you neither
  request it nor wait for it, and you do not report that a review "is running". Do not request any
  other bot reviewer. The manager runs `review-mesh` against your PR after you report, and handles
  Bugbot's threads itself. Your step 12 is: push, open the PR, report, stop.
- Keep the diff lazy: stdlib before custom code, a native platform feature before a dependency, an
  installed dependency before a new one, one line before fifty. No speculative abstractions. Never
  trim trust-boundary validation, data-loss handling, security, accessibility, or your TDD test. If
  `ponytail-review` is installed, run it on your diff and fold in cheap behavior-preserving cuts
  before pushing — ponytail's always-on ruleset comes from a session hook that does NOT fire for you
  as a dispatched subagent, so this is the only version of it you get.
- Trust the bundled context; only re-fetch a genuinely missing field.

When your work is pushed and verified, **report and stop.** Don't sleep-poll CI and don't re-emit
your report — the manager watches CI itself and every extra wake costs it a turn.

Report back this exact block and nothing after it:

WORKER_REPORT
issue: <NUMBER>
pr_number: <PR>
pr_url: <URL>
branch: <BRANCH>
worktree: <PATH>
commits: <comma-separated subjects>
ci_status: <triggered|green|red|unknown>
tests: <db_set|db_unset — which suites actually ran>
lint: <clean|failing|skipped:<reason>>
docs: <updated:<comma-separated paths>|none-needed:<why>>
ponytail: <clean|deferred:<one-line summary>|skipped:<reason>|n/a>
notes: <anything the manager should know — deferred AC, surprises>
END_REPORT
```

Field semantics the manager surfaces later:
- `tests` — `db_unset` means the integration tests skipped; CI is then the only real gate and the
  merge log line must say so.
- `lint` — oxlint isn't in CI, so a `failing` here is a real finding, not a nit.
- `docs` — `none-needed:<why>` is a claim the manager checks against the diff. An observable change
  with no docs edit and no convincing reason is a finding to fix before merge, not a follow-up issue.
- `ponytail` — `deferred:<summary>` when a real simplification was left for follow-up because it'd
  change behavior or need a test rewrite.
