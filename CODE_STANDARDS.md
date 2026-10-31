# Code standards

This file is the normative standard for style, testing, and lint policy. It
binds people and agents. [AGENTS.md](AGENTS.md) owns operational traps and says
which sections to open. [CONTRIBUTING.md](CONTRIBUTING.md) owns contribution
process: setup, sign-off, commit format, and branch names. Research notes are
rationale, not a second standard.

The standard states intended policy. Workflow and configuration files show what
actually runs. When they disagree, report that and fix it in the change that
notices it. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the main
CI workflow. Other workflows, including CodeQL, keep their own role. This file
does not list every job, and it is not a gate specification.

<a id="working-rules"></a>

## Working rules

Read this section before editing the repository. Then read every section the
change needs, in full. For Go, read [Format and review](#go-format),
[Names and packages](#go-names), and [Errors](#go-errors), plus
[HTTP](#go-http), [Logging and configuration](#go-logging), and the SQL section
when the change touches them. For frontend work, read
[TypeScript and React](#ts-style). For a behavior or test change, read
[Testing](#testing) and the matching subsection. For lint or CI, read
[Lint policy](#lint-policy). A documentation-only edit needs this section,
[Language](#language), and [Changes](#scope). A fragment link helps you find a
section. It does not replace reading that section.

One concern per change. Leave unrelated code untouched: no drive-by refactor,
repo-wide reformatting, or speculative abstraction. Match the code around the
edit. Prefer clear, simple, concise expression. Use the standard library and
dependencies the repository already has. A new dependency, lint tool, or large
change needs an issue first.

Write US English. See [Language](#language).

A behavior change needs a behavioral test that was seen to fail without the
change. See [Testing](#testing). Update the public docs that change affects,
in the same pull request. See [Changes](#scope).

Report what you actually ran: the commands, whether `TEST_DATABASE_URL` was
set, any skip opt-out, the memory and concurrency bounds, and what you did not
run. Claim a check only after you have seen it pass.

## Go

<a id="go-format"></a>

### Format and review

Format Go with `gofmt`. `go vet ./...` must pass. CI runs both in the `go` job.

Group imports with the standard library first, as in the
[Go review guidance on imports](https://go.dev/wiki/CodeReviewComments#imports).
Review is the check. A later issue may replace that with goimports. That
change has to review imports that were added or removed, and it has to retire
the separate formatting check. Two formatter gates at once are not the goal.

<a id="go-names"></a>

### Names and packages

Use idiomatic Go names, stable initialisms, and packages with a clear
responsibility. Add an interface when a real caller needs one. Match nearby
code. Review is the check. This standard adds no naming analyzer and no list
of forbidden package names.

<a id="go-errors"></a>

### Errors

Wrap library errors with context: `fmt.Errorf("reading foo: %w", err)`. Keep
messages lowercase and readable by a person. Handle errors explicitly. An
unexpected discarded error needs review. Intentional best-effort cleanup is
judged in its own context. This standard adds no errcheck gate, and it does
not require unrelated edits to existing cleanup.

<a id="go-http"></a>

## HTTP

Success responses use the package-local `writeJSON`. Errors use a literal JSON
body, for example
``http.Error(w, `{"error":"session not found"}`, http.StatusNotFound)``.
The message is lowercase and explains the problem to a person.

Kind configs decode with `DisallowUnknownFields`. A `StateFunc` returns only
redacted, client-safe data, because that result is broadcast to every
participant. That decoding rule applies to kind configs. Extending unknown-field
rejection to other endpoints is a separate change. How kinds are registered,
redacted, and broadcast is an operational mechanism under `docs/agents/`.

<a id="go-logging"></a>

## Logging and configuration

Log with `log/slog` as JSON on stdout. Boot and config failures log `FATAL:`
through `slog` and exit via `os.Exit(1)`. The message tells the operator what
to change.

Read configuration with `os.Getenv` and the local `envOr` helper. Validate it
once in `loadConfig`. Request-ID trust and secret-free security-event logging
are operational rules under `docs/agents/`.

## SQL

A shipped migration is append-only. Never edit or renumber one that has already
shipped. New migrations are forward and additive, run one per transaction, and
use a purely numeric filename prefix (`0010_thing.sql`). A prefix such as
`0010a` is rejected at startup. A migration must stay safe while more than one
replica is running.

"Shipped" means a migration the running database may already have applied. A
future immutability check has to define its protected set in its own issue.
Startup refusal, embedding, and the migration lock are operational mechanisms
under `docs/agents/`.

<a id="ts-style"></a>

## TypeScript and React

### Toolchain

TypeScript strictness follows the compiler default. Project references cover
the application, Node, and test configs. The references do not themselves turn
strictness on.

oxlint is the JavaScript linter, configured for `web/` and invoked with
`npm run lint`. CI runs that script in the `web` job. This standard adds no
second JavaScript lint stack.

The lockfile is the toolchain. An older local install is not evidence of what
CI runs. Verify with a clean install from the lockfile.

### Layout

Use PascalCase components in `web/src/components/`, pages in `web/src/pages/`,
helpers in `web/src/lib/`, and design tokens in `web/src/tokens.css`. Use the
existing tokens and match the surrounding code. Moving to feature folders is
separate work.

### Memoization

Memoize when a measurement shows it is needed. Leave existing memoization in
place unless a measurement justifies the change.

<a id="testing"></a>

## Testing

### When a test earns a place

A behavior change needs a meaningful behavioral test, and that test must have
been seen to fail without the change. Assert observable outcomes, including
denial, redaction, persistence, and lifecycle order. A test whose only goal is
coverage of a private helper does not meet this bar.

Two tests may both fail under one mutation when they cover different
transports, principals, or serializers. Keep both when each protects a real
boundary. Negative and failure requirements in
[docs/security/README.md](docs/security/README.md) stay in force. This standard
sets no coverage threshold.

<a id="go-tests"></a>

### Go

Use the standard library `testing` package. Keep helpers in the package's
`_test.go` files. Exercise HTTP with `httptest.Server` against a real
`pgxpool`. Database behavior runs against real Postgres.

Database-backed tests fail when `TEST_DATABASE_URL` is unset. They do not
skip. `PARLEY_SKIP_DB_TESTS=1` is the only opt-out, and it is parsed strictly.
Accepted values are listed in [CONTRIBUTING.md](CONTRIBUTING.md). CI rejects
the variable and any skipped test. When you report a passing run, say whether
the database was set and whether the opt-out was used. A pure test may skip
the database. Its report must still say that the database suite was not run.

`-p 1` is required. Packages share one test database and migrate it. See
[Test resources](#test-resources) for memory and worker bounds.

A handler test builds its own `api.Options`, so it cannot prove the binary
wires a field. An `api.Options` field is inert unless `cmd/parley` maps it.
Wire new fields in `apiOptions` and cover that mapping from `cmd/parley`,
including `cmd/parley/plugin_wiring_test.go`, which enumerates exported fields.
The same rule applies to any configuration `main` passes through a struct
literal.

A guard's test must fail when the guard is broken. `scripts/guard-mutation.sh`
is that check. Moving a line a mutation anchors on means moving the mutation
with it.

<a id="test-resources"></a>

### Test resources

Before running tests, choose an enforced memory budget that covers
subprocesses, and use finite worker counts.

Prefer a shared cgroup, container, or systemd limit. When that is unavailable,
document a validated inherited process memory limit and bound subprocess and
worker counts. That fallback applies per process. It is not a shared pool.
`GOMEMLIMIT`, or a Node heap limit, does not by itself bound the whole run.

Go uses `-p 1` and, where a package starts its own workers, an explicit
in-package concurrency bound. Frontend runs set a finite worker count. Avoid
overlapping large suites.

The execution procedure is a bounded recipe for the environment you are using.
An illustrative command with no memory or worker bound is not that procedure.
This requirement stands on its own. It does not claim that current CI already
applies these bounds.

<a id="ts-tests"></a>

### Frontend

The frontend suite is Vitest, jsdom, and Testing Library. Run it with
`npm test` from `web/`. Tests sit beside their subject as `*.test.ts` or
`*.test.tsx`. `src/test/render.tsx` supplies the providers screens assume. The
suite stays thin: no jest-dom matchers and no Vitest `globals`. The test
TypeScript project remains part of type-checking.

Accessibility uses axe-core. `src/test/axe.ts` exposes `expectNoViolations`,
and a component that owns fetches asserts in its own test, where its mock
already exists. jsdom has no layout, so it does not check color contrast or
target size. Those need a real browser.

CI runs this suite with `npm test` in the `go` job, in the step that builds
the embedded frontend. A later split of that job must keep the behavior tests.
A build and lint job alone does not replace them.

### Leaves

Prefer a public behavior over an incidental snapshot, a log-wording assertion,
or the shape of a helper. A constant or a log line still deserves a test when
a product or security invariant depends on it. Test a SQL claim with SQL.
These rules are not grounds for deleting a negative test that still has no
equivalent.

<a id="lint-policy"></a>

## Lint policy

Adopted checks are `gofmt`, `go vet ./...`, oxlint via `npm run lint`, and the
TypeScript build. `gofmt` and `go vet` run in the `go` job. `npm run lint`
runs in the `web` job. Behavioral suites and security controls are separate
checks. Workflows and config files show where each command runs. This file
does not drive CI, and it is not a catalog of image, release, Helm, or DCO
jobs.

A new analyzer, wrapper, formatter, or blocking threshold needs its own issue,
a compatible pinned toolchain, a review of the findings, measurements of
execution time and resources, and a scoped decision to adopt it. Staticcheck,
including its SA checks, and type-aware rules for unhandled promises are
candidates for that kind of trial. They are not gates. A findings inventory is
allowed. A bulk suppression file whose purpose is to hide defects is not the
end state. Adopting Staticcheck keeps `go vet`. Adopting type-aware lint keeps
`tsc -b`. A second compiler-diagnostics pass needs its own justification.

The repository has no golangci-lint config. Adding one is a new tool, so it
needs the issue and the measurements above. Folding a new linter into an
unrelated change is out of scope. This standard sets no coverage gate, no
prose linter, and no second JavaScript lint stack.

<a id="language"></a>

## Language

Write US English (en-US) in UI copy, consent text, errors, comments, and docs.
No en-GB spellings. This standard adds no prose linter.

<a id="scope"></a>

## Changes

One concern per pull request. Leave unrelated refactors, repo-wide
reformatting, and speculative abstractions out of the change. A new
dependency, lint tool, or large change needs an issue before code is written.

A behavior change updates the affected public docs in the same pull request.
That duty is broader than defaults, limits, and security properties. Those
three also require the relevant `site/` page in that same pull request, and
its `VerifiedStamp` when that page has one. When no public doc is affected,
say so briefly in the review.

Report the verification you ran. Name the commands, whether
`TEST_DATABASE_URL` was set, any skip opt-out, the memory and concurrency
bounds, and the limits of what you could not run. Procedure for commits,
sign-off, and branches stays in [CONTRIBUTING.md](CONTRIBUTING.md). Read it
when you do those things.

<a id="not-here"></a>

## Not part of this standard

Incident history, route catalogs, lock identifiers, the operator configuration
reference, the assurance register, generated consent wording, release and
screenshot procedure, and the full CI job inventory already have owners.

Adopting Storybook, a design-system package, React Compiler, a second Go
module, a route-chunk strategy, new dependency automation, or a permanent
analyzer ban would each be its own decision. This standard does not make those
decisions.
