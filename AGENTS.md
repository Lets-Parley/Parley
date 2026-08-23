# AGENTS.md

Operating notes for anyone — person or coding agent — making changes to Parley.
This is the stuff you cannot infer by reading the code. For what Parley *is*, see
[README.md](README.md); for policy, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository overview

Parley is a self-hosted planning-poker and standup tool that ships as **one Go
binary plus Postgres**. The React frontend is compiled into the binary with
`go:embed`, so there is no Node runtime in production.

Module `github.com/lets-parley/parley`, Go 1.26.3, chi + pgx + gorilla/websocket.

| Path | Contents |
| --- | --- |
| `cmd/parley/` | config from env, boot, graceful shutdown |
| `internal/api/` | chi router, identity, spaces, sessions, passcodes, authz, export, WebSocket |
| `internal/auth/` | OpenID Connect relying party |
| `internal/db/` | pool, `migrations/*.sql` (embedded, run at boot behind an advisory lock) |
| `internal/hub/` | WebSocket fan-out and presence |
| `internal/poker/`, `internal/standup/` | the two session kinds |
| `internal/session/` | kind registry and the wire envelope |
| `internal/store/` | Postgres queries |
| `web/` | Vite + React app; `web/embed.go` embeds `web/dist` |
| `site/` | Astro/Starlight docs, published to www.letsparley.io |
| `deploy/k8s/` | Kubernetes manifest |

## Development

```sh
cd web && npm ci && npm run build && cd ..   # REQUIRED before any go build or go test
export DATABASE_URL=postgres://parley:dev@localhost:5432/parley
go run ./cmd/parley
```

Frontend work, with hot reload against a running backend:

```sh
cd web && npm run dev            # Vite on :5173, proxies /api and /ws to :8080
```

`web/embed.go` declares `//go:embed all:dist` and nothing under `web/dist/` is
tracked — a fresh clone has no `dist` directory at all. **Skipping the npm build
makes Go compilation fail** (`pattern all:dist: no matching files found`), and a
stale `dist` compiles fine while silently serving an old UI. When in doubt,
rebuild it.

`DATABASE_URL` has no default and is fatal if missing. Everything else is
optional: `PORT`, `BASE_URL`, `LOG_LEVEL`, `TRUST_PROXY_HEADERS`, `AUTH_MODE`,
and the `OIDC_*` set when `AUTH_MODE=oidc`. See `.env.example`.

## Testing

```sh
export TEST_DATABASE_URL=postgres://test:test@localhost:5432/test
go vet ./...
go test -p 1 -race ./...        # this is what CI runs
cd web && npm run lint          # oxlint — CI does NOT run this, so you must
```

Without `TEST_DATABASE_URL` the database-backed tests **fail**; they do not
skip. `PARLEY_SKIP_DB_TESTS=1` is the only opt-out — it is parsed strictly, so
`PARLEY_SKIP_DB_TESTS=0` runs the tests and an unrecognised value is a hard
failure — it prints a warning naming the packages it silenced (visible in a
terminal, or under `-v`/`-json`; see CONTRIBUTING.md), and CI rejects both the
variable and any skipped test. Do not reintroduce a silent skip — roughly two thirds of the suite is
database-backed, so a skip is a green run that verified nothing.

- **`-p 1` is mandatory.** Every package shares one test database and migrates
  it; parallel packages race and fail confusingly.
- **Never report a passing test run without saying whether the database was
  set.** Without `TEST_DATABASE_URL` the database-backed tests fail rather than
  skip, so a green run is meaningful — but only if the opt-out was not used.
- Behavioural changes need a test, and the test must have been *seen to fail*
  before the fix.
- Style: stdlib `testing`, no assertion library, `httptest.Server` against a
  real `pgxpool`, helpers colocated in the package's `_test.go` files.
- The frontend suite is Vitest + jsdom + Testing Library: `cd web && npm test`
  (`npm run test:watch` while working). Tests sit beside their subject as
  `*.test.ts`/`*.test.tsx`; `src/test/render.tsx` supplies the three providers
  every screen assumes. It is deliberately thin — no jest-dom matchers, no
  `globals: true`, so nothing had to be added to `tsconfig.app.json`.
- Frontend behaviour changes need a test too, and the same rule applies: it
  must have been seen to fail first. Every defect this project has shipped in
  `web/` — the dead claim button, the member card, the frozen standup timer —
  passed a green build.

`.github/workflows/ci.yml` is the authoritative gate. Its `first-run` job also
builds the Docker image and boots it against an empty database, which catches
migration and embedding mistakes that unit tests miss.

## Code conventions

- Go is `gofmt`-formatted and must pass `go vet ./...`. There is no
  golangci-lint config; don't add one as a drive-by.
- Wrap errors in library code: `fmt.Errorf("reading foo: %w", err)`.
- HTTP handlers return literal JSON error bodies —
  ``http.Error(w, `{"error":"session not found"}`, http.StatusNotFound)`` — and
  use the package-local `writeJSON` on success. Messages are lowercase and
  explain the problem to a human.
- Boot and config failures log `FATAL: …` via `slog` and `os.Exit(1)`, with a
  message that tells the operator what to change.
- Logging is `log/slog` JSON to stdout; config is read via `os.Getenv` and the
  local `envOr` helper, validated once in `loadConfig()`.
- Session kinds are registered into a `session.Registry` in `api.Router`, each
  built by its package's `Kind()` constructor (`poker.Kind()`, `standup.Kind()`).
  Kind configs decode with `DisallowUnknownFields`, and a `StateFunc` must return
  only redacted, client-safe data — it is broadcast to every participant. The
  full three-step checklist for adding a kind — register it, seed its
  `session_kinds` row in a new migration, add its `KindDef` to
  `web/src/lib/kinds.ts` — is in
  `site/src/content/docs/project/contributing.mdx`.
- Frontend: TypeScript strict via project references, oxlint
  (`web/.oxlintrc.json`), PascalCase components in `web/src/components/`, pages
  in `web/src/pages/`, helpers in `web/src/lib/`, design tokens in
  `web/src/tokens.css`.

## Gotchas

1. **Migrations are append-only.** `internal/db/migrations/*.sql` are embedded
   and versioned by filename sort order. Never edit or renumber a shipped
   migration — the running database has already applied it. The binary refuses
   to start if the database is ahead of it (`internal/db/migrate.go`).
2. **`web/dist/**` is build output.** Never hand-edit it.
3. **Parley runs on more than one replica.** Fanout, presence and the passcode
   throttle all go through Postgres, and `db.Migrate` serializes simultaneous
   boots behind an advisory lock (`migrationLockID`). The WebSocket hub is
   still in-process, but that is per pod and no longer authoritative for
   anything. If you ever add another advisory lock, give it its own id:
   a blocking lock on an id the process already holds deadlocks every boot.
4. **`BASE_URL` is security config.** It drives the WebSocket origin check and
   whether the session cookie is `Secure`. Claiming `https` while serving plain
   HTTP makes sign-in appear to work but never persist.
5. **`TRUST_PROXY_HEADERS=true` without a real proxy in front is a
   vulnerability** — clients can forge `X-Forwarded-For` and defeat the room-code
   throttle. Default it to false.
6. **Middleware is scoped to `/api`, not global.** `rejectCrossSite` and
   `requireJSONBody` are registered inside `r.Route("/api", ...)`
   (`internal/api/router.go`). A new top-level route gets neither — `/auth` sits
   outside on purpose because identity-provider redirects are browser
   navigations, and it carries its own CSRF defence in the sign-in cookie's
   state value. If you add a route group, decide its CSRF story explicitly.
7. **`/healthz` must never touch the database; `/readyz` does.** A database blip
   restarting the process would drop every live WebSocket. Preserve the split.
8. **OIDC discovery happens on first sign-in, not at boot**, deliberately, so a
   broken identity provider cannot stop the server from starting. Not a bug.
9. Docker (not podman), distroless nonroot final image, container healthcheck is
   the binary itself (`/parley -healthcheck`). Postgres is pinned to
   `16-alpine` on purpose — an unplanned major upgrade breaks the data directory.
10. Docs pages carry a `VerifiedStamp` recording the version and source file they
    were transcribed from. Changing a default, limit, or security property means
    updating the `site/` page **and** its stamp in the same PR.
11. **The docs site writes the current release down once**, in
    `site/src/version.mjs`. Pages carry `%VERSION%` and an mdast plugin
    substitutes it at build time, prose and code fences alike. A release means
    editing that one line and merging it — that push under `site/**` is also
    what redeploys the site, since `release.yml` never touches `site/`. Leave
    minimum-version sentences ("chart 0.4.1 or newer") and historical
    references literal; they are not the current version.
12. **`users.link_id` is `on delete set null`, never cascade.** `votes`,
    `standup_entries` and presence all cascade from `users`, so cascading a
    signed link's delete into its holders would erase their votes and updates
    from a finished meeting and from any CSV exported afterwards. Link rows are
    never swept either — a link expires on its own `expires_at`, it is not
    garbage-collected.
13. **Every new route must be classified for signed-link guests.** A redeemed
    link is a principal with no space membership, and it reaches any route that
    does not sit behind `RequireUser` or `requireSpaceOwner`.
    `TestLinkGuestRouteTable` (`internal/api/link_routes_test.go`) walks chi's
    registered routes and fails on any pattern it does not already classify, so
    adding a route means deciding in that table what a link guest gets from it.
    The rule: participate actions and reading the bound room; everything else
    401, 403 or 404. Reject one with the `rejectLinkPrincipal` middleware, and
    put a second lock in the statement itself for anything that would escalate
    (see `store.ClaimFacilitator`).
14. **A signed link's expiry lives on the session token it mints**
    (`session_tokens.expires_at`), never on a timer or a sweeper. `hub.validate`
    already re-reads token validity on a ticker, so that column is the whole of
    mid-session severance. `ResolveToken` and `TokenExpiry` must both honour it —
    one of them skipping it leaves a lapsed link either answering requests or
    holding a socket.
15. Dependabot watches only `site/`. Go modules and `web/` dependencies are
    bumped by hand, with tests.

## Scope

One concern per pull request. No unrelated refactors, no repo-wide reformatting,
no speculative abstractions, and no new dependencies or lint tooling without an
issue first. For anything large, open an issue before writing code.

## Commits and pull requests

- Conventional Commits, lowercase and imperative, scope optional:
  `feat(web): …`, `fix: …`, `docs: …`, `chore: …`. The body is prose explaining
  the motivation. Squash merges append `(#NN)`.
- Branches are `type/kebab-slug`, e.g. `feat/oidc-and-hardening`,
  `docs/roadmap-structure`.
- Behaviour changes update the `site/` docs in the same PR.
- Report verification honestly: name the commands you ran and whether
  `TEST_DATABASE_URL` was set. Never claim a check passed that you did not run.

## Further reading

- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution policy and migration rules
- [SECURITY.md](SECURITY.md) — report vulnerabilities privately, never as a
  public issue
- [ROADMAP.md](ROADMAP.md) — what is planned now, next, and later
- `.github/workflows/ci.yml` — the checks that must pass
- `site/src/content/docs/` — user-facing documentation source
