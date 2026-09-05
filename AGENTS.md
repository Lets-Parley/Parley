# AGENTS.md

Operating notes for anyone — person or coding agent — making changes to Parley.
This is the stuff you cannot infer by reading the code. For what Parley *is*, see
[README.md](README.md); for policy, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository overview

Parley is a self-hosted planning-poker and standup tool that ships as **one Go
binary plus Postgres**. The React frontend is compiled into the binary with
`go:embed`, so there is no Node runtime in production.

Module `github.com/lets-parley/parley`, Go 1.26.6 (`go.mod`); the container build
uses the newer `golang:1.27` toolchain image (`Dockerfile`) deliberately, not a
drift — chi + pgx + gorilla/websocket.

| Path | Contents |
| --- | --- |
| `cmd/parley/` | config from env, boot, graceful shutdown |
| `internal/api/` | chi router, identity, spaces, sessions, passcodes, authz, export, WebSocket |
| `internal/auth/` | OpenID Connect relying party |
| `internal/db/` | pool, `migrations/*.sql` (embedded, run at boot behind an advisory lock) |
| `internal/hub/` | WebSocket fan-out and presence |
| `internal/poker/`, `internal/standup/` | the two session kinds |
| `internal/session/` | kind registry and the wire envelope |
| `internal/plugin/` | the plugin host: Extism/wazero runtime, capability-checked host functions, the fetch guard, containment — plus the event bus, outbox worker, job queue and plugin storage it runs on |
| `internal/store/` | Postgres queries |
| `web/` | Vite + React app; `web/embed.go` embeds `web/dist` |
| `site/` | Astro/Starlight docs, published to www.letsparley.io |
| `deploy/k8s/` | Kubernetes manifest |
| `plugins/` | Ceremony plugins that must not touch the host (`plugins/retrospective/` is the proof) |

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
- Accessibility is checked by axe-core: `src/test/axe.ts` exposes
  `expectNoViolations(container)`, and `src/components/a11y.test.tsx` runs it
  over the props-only components. A component that owns fetches asserts it in
  its own test, where the mock already exists. jsdom has no layout, so colour
  contrast and target size are not covered — those still need a real browser.
- **A feature gated on an `api.Options` field is dead unless `main` sets it,
  and no handler test can tell you that.** Every test in `internal/api`
  constructs its own `Options`, so a handler is always exercised with the
  field populated and always passes — while the shipped binary takes the
  zero-value early return. `PLUGIN_DIR` shipped exactly this way: parsed,
  logged, handed to the WASM runtime, and never put in the `api.Options`
  literal, so the plugin UI answered 404 and an empty panel list in
  production through two review rounds and sixteen green checks. When you add
  an `Options` field, wire it in `cmd/parley/main.go`'s `apiOptions` and
  cover it there: `cmd/parley/plugin_wiring_test.go` drives a real router
  built from that mapping, and enumerates every exported field so the next
  absent wire fails rather than ships. The same shape applies to any
  configuration that reaches a subsystem through a struct literal in `main`.
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
  built by its package's `Kind()` constructor (`poker.Kind()`, `standup.Kind()`)
  — plus, at runtime, the kinds every enabled plugin install provides.
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
15. **Every hub callback that reaches the database from its own goroutine goes
    through `hub.track`, and presence is recorded before the initial frame is
    released.** Two rules, one lifecycle. `Hub.Shutdown` waits on a `WaitGroup`
    covering `OnDisconnect`, `OnPresenceChange`, `OnFacilitatorSeen` and the
    validation goroutines, because the caller closes the pgx pool the instant it
    returns — a `go h.Whatever(...)` added outside `track` shows up as `closed
    pool` errors in an unrelated test minutes later. A callback invoked
    synchronously on a goroutine the hub already owns needs no `track`: the
    attach-time `OnFacilitatorSeen` below is deliberately one of these, since
    `AttachAuthenticated` must not return until it has run — and it calls
    `confirmMembership`, then `OnFacilitatorSeen`, then `releaseInitial`, in
    that order. The re-check comes first because a connection it rejects must
    leave no presence row behind for another client's roster; presence still
    comes before the frame, so a client holding its first state frame may
    assume its own presence row exists. `Envelope.RedactForGuest`
    filters participants to presence ∪ facilitator, so reordering those two turns
    every guest-visibility assertion into a coin flip. A registered connection
    is not a broadcast recipient until that first frame has been delivered:
    broadcasts carry one shared guest payload redacted with no self id, so one
    fired inside that window would tell a link guest it is not in its own room.
    Dropping those frames loses nothing, because the initial frame lands after
    them and would have overwritten them.
16. **A space slug is unique inside an org, not across the instance, and every
    space lookup carries an org.** `Spaces.Create` and `Spaces.BySlug` take an
    org id (`internal/store/spaces.go`); handlers get it from `app.orgID`,
    which resolves the default org lazily because `Router` must not require a
    reachable database. `spaces.org_id` keeps a column default for one release
    so a replica on the previous binary can still insert; `on delete restrict`,
    because cascading from `orgs` would erase a tenant's whole history.
    `spaces.visibility` defaults to `'private'` so an upgrade discloses exactly
    what it did the day before, and open mode forces `'private'` on new spaces:
    it mints anonymous identities, and an org-visible space with no passcode
    would be a room any visitor could walk into.
17. **A backfill that says "every user" must exclude `users.link_id is not
    null`.** A redeemed signed link mints an ordinary `users` row, but that is
    a capability on one room rather than an account (`Principal.LinkSessionID`).
    Enrolling those rows in an org hands directory visibility to anyone ever
    sent a guest link — and the mistake is invisible on any instance that has
    never issued one.
18. **Claim-derived membership never overrides a revocation tombstone.**
    `Orgs.GrantMember` (`internal/store/orgs.go`) inserts and does nothing on
    conflict; `Orgs.AddMember` is the deliberate, admin-driven counterpart that
    restores a revoked row and re-applies the role. Every sign-in re-grants
    from the claim, so a grant that cleared `revoked_at` would undo an admin's
    removal at the revoked person's next login. Sign-in mapping and open-mode
    enrolment both go through `GrantMember`.
19. **The org in a request comes from `requireOrgMember`, never from chi twice.**
    Space routes are mounted under `/api/orgs/{org}/`. `orgSlugFromRoute`
    (`internal/api/authz.go`) is the only reader of that URL segment, and
    `orgFrom(ctx)` is how every handler behind the middleware gets the org —
    with an unchecked type assertion, so a handler mounted outside it panics
    rather than reading a zero uuid and skipping the tenancy check.
    `TestOrgParamHasOneReader` enforces this with go/types, so
    `chi.URLParamFromCtx` and `RouteContext().URLParam` are caught too.
20. **Sitting behind `requireOrgMember` is not the tenancy boundary.** It
    proves the caller is in org A and says nothing about which org a space
    resolved by slug belongs to: `spaces.slug` is unique per org, so every
    lookup behind it must also filter by `orgFrom(ctx).ID`.
    `TestSpaceRoutesResolveWithinTheDefaultOrg` puts an identically-slugged
    space in a second org and asserts 404 per route.
21. **`GET /api/orgs/{org}/spaces/{slug}` must stay one query.** It is the
    anonymous link landing, so a bad org, a space in another org, and a slug
    that exists nowhere have to fail after identical work — hence
    `Spaces.BySlugInOrg`. Resolving the org first and the space second is a
    cross-org existence oracle even with identical response bodies.
22. **The session tree and `POST /api/links/redeem` never acquire an org
    prefix.** A link guest belongs to no org and no space, so it has no org
    slug for a URL and no membership to derive one from; prefixing either would
    break every signed link ever issued. `TestEveryRouteIsScopeClassified`
    fails the build on any route that is not explicitly classified.
23. **Every space URL in `web/src` comes from `lib/paths.ts`.** SPA routes, API
    calls, the copied invite and the rename toast's prose all build from
    `spacePath` / `spaceSettingsPath` / `spaceApi` — a slug alone is not an
    address any more, and the one site written out by hand is the one that
    404s. `renderApp` takes a `path` so `useParams` actually resolves in tests.
24. **`GET /s/{slug}` resolves only against the caller's own org
    memberships.** It is the shim keeping links shared before space URLs
    carried an org alive, and it must never do a global slug lookup: that
    would answer differently for a slug held in an org the caller is outside
    than for one that exists nowhere. Zero matches and more than one both
    answer 404 — guessing between two of the caller's orgs would drop them in
    the wrong tenant's room. Anonymous callers and link guests fall through to
    the SPA, and it is a 302, not a 301, because a membership can be revoked.
25. **Space visibility governs discovery, never entry.** `spaces.visibility`
    decides whether a space is listed to its org by
    `GET /api/orgs/{org}/spaces`; the passcode still decides who is let in, and
    `handleJoinSpace` compares it identically whatever the visibility. So
    `PATCH .../visibility` must never write the passcode and
    `POST .../passcode` must never write the visibility — "listed but locked"
    is a real state and neither route may silently strip the other. Two
    refusals hold the boundary: open mode is refused `org` visibility *before*
    the store call, so the PATCH cannot route around the guard in
    `handleCreateSpace`; and the directory is mounted inside `RequireUser` and
    then `requireOrgMember`, in that order, so a link guest is refused 401 at
    the first of them. If the directory ever answered for a link guest, one
    link to one standup would list every org-visible space on the instance.
26. **Org custody is management without access, and four things enforce it.**
    (a) Custody handlers live in `internal/api/custody`, which imports neither
    the session, presence and hub packages nor `internal/store` — a `go list
    -deps` test fails the build if that changes, and the two duplicated
    constant blocks are the deliberate price. (b) They answer with
    `CustodySpace` and nothing else; a test reads the response as raw JSON and
    rejects any key outside the allow-list, because reflecting over the struct
    would not catch a handler marshalling an untyped map. (c) Custody may only
    make a space **more** private: `private` → `org` is 403 there and stays
    the space owner's alone, or an admin widens a private space, joins it as an
    ordinary org member and has everything by a different door. (d) Ownership
    is granted, never transferred — an existing member only, never the admin
    themself, and never demoting an incumbent.
27. **An org-level revoke must not strand a space.** The last-owner guard in
    `store.Spaces.mutateMembership` runs one space at a time, so the
    cross-space delete in `custody.Store.RevokeOrgMember` has to do the same
    job itself: promote the most recently active remaining member (0015's rule,
    `last_seen_at` then `user_id`) where the revoked person was sole owner, and
    refuse the whole revoke — writing nothing — where there is nobody to
    promote. The tombstone is an upsert, never an update: somebody with no
    `org_members` row yet must still be revocable before their first sign-in.
28. **`org_audit_log`'s foreign keys must never cascade.** Both are `on delete
    set null` and both slugs are stored as text, so a record outlives the space
    and the org it names. The org purge deletes exactly those things, so a
    cascade would erase the record of the action most worth recording.
29. **The org purge is one transaction, and the counts are read inside it.**
    `spaces.org_id` is `on delete restrict`, so spaces go before the org row;
    an interrupted purge must leave everything standing rather than some spaces
    gone, the rest not, and the org row undeletable. It refuses without the
    org's own slug as `confirm`, and it refuses the default org outright.
30. **Every environment variable is named in both operator-facing places.**
    `TestEveryEnvironmentVariableIsDocumented` walks `cmd/parley/main.go` and
    requires each key it can read to appear in
    `site/src/content/docs/reference/configuration.mdx` *and* in
    `deploy/charts/parley/values.yaml`. It resolves the callee rather than
    grepping, because most of the configuration goes through `envOr` and a
    literal `os.Getenv` scan covers eight keys out of twenty-two. Add a third
    helper to `envReaders` if you write one; a key that only a new helper reads
    is invisible otherwise, and the test fails if a name in that map is never
    called. `env_keys_allowlist.txt` holds only keys no scan of `main.go` can
    find, and an entry the scan *can* find is an error so the list cannot
    accumulate. Finding zero keys is a fatal failure, never a pass.
31. Screenshots go stale silently. `site/src/assets/screenshots.json` maps each
    shipped screenshot to the `web/src` files it depicts and the commit it was
    last shot against; `scripts/check-screenshot-freshness.sh` reports the drift
    and CI surfaces it on any pull request touching `web/src`. The drift itself
    is advisory and never fails; a manifest the checker cannot read does exit
    nonzero, because a report that claims the set is fresh has to mean it
    looked. `depicts` paths are literal and must exist at `HEAD` — an empty
    list, or one naming a file that is gone, is reported rather than counted
    clean. If you re-shoot, move `shot_at`; if you add a shot, add it to the
    manifest.
32. `internal/plugin` has two delivery paths and they are not interchangeable.
    Core subscribers (`Bus.SubscribeCore`) are in-process and synchronous, so
    the state broadcast stays instant. Plugin subscribers go through the
    outbox and are **at-least-once**: any handler you write for that path must
    be idempotent. Do not put plugin delivery in the websocket hub — it stays a
    dumb fanout. Claims in the outbox and the job queue take a lease as well as
    `for update skip locked`; the lock is released at commit, so without the
    lease a second worker re-delivers a row that is still marked pending.
33. Dependabot watches only `site/`. Go modules and `web/` dependencies are
    bumped by hand, with tests.
34. `.dockerignore` patterns match source paths too, not just real secrets.
    `**/secrets*` also matched `internal/plugin/secrets.go` and dropped it
    from the Docker build context, so `plugin` lost symbols another file in
    the package referenced. A red `docker build and smoke` alongside a green
    `go` check on the same commit means a file got excluded from the image
    build, not a real compile error — diff `.dockerignore` against the PR's
    new filenames before chasing the symbol.

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

35. **Plugin sandbox guards are covered by mutation, not by a passing test.**
    `scripts/guard-mutation.sh` is a CI leg: it breaks each guard in
    `internal/plugin`, `internal/api` and `web/src` on purpose and fails if the
    test covering it stays green. `target <tree> [go|web]` switches which tree
    the mutations after it patch, and the web ones are gated on `tsc -b` rather
    than a Go build.
    If you add a guard, add its mutation; if you move the line a mutation
    anchors on, the leg fails loudly with `MUTATION SETUP FAILED` rather than
    quietly passing. Several guards are enforced at two sites on purpose (the
    call timeout and the memory cap are set both on the wazero runtime and in
    the Extism manifest) — mutate every site at once or the leg reports a
    survivor that is really the second site holding.

36. **The plugin UI frame's header carve-out is a chi route group, never a
    path check.** `securityHeaders` sets `X-Frame-Options: DENY` for the whole
    instance, and a framed document that carries it is blocked before its CSP
    is read — so `/plugin-ui/…` is registered in its own group, which never
    runs that middleware. Do not "simplify" this into a prefix check inside
    `securityHeaders`: a prefix check is a matching rule, and matching rules
    get evaded. `TestEveryNonPluginRouteStillSendsXFrameOptionsDeny` walks the
    real routing tree, so a route that drifts into the group goes red.

37. **Nothing reaches a plugin frame that `redactSession` did not build.** It
    is a projection, not a filter: vote values are written into it only once
    the round is revealed, so a pre-reveal value has no path into the payload.
    Do not rewrite it as "copy the envelope, then delete what is hidden" — a
    field the projection never writes cannot be forgotten, and a field a filter
    does not know about is shipped.

38. **Plugin capability grants are checked inside the host function, never at
    load time and never against the bundle.** `Store.State` is read on every
    call so a revoked grant stops working on the next call rather than the next
    restart. Do not add a cache in front of it without a way to invalidate it,
    and never read capabilities from anything the plugin author writes.

39. **The plugin fetch guard resolves once, screens every record, and dials the
    address it screened — for every redirect hop.** Do not "simplify" it into
    an `http.Client` with `CheckRedirect`; following redirects with the
    standard client re-resolves the hostname and re-checks nothing, which is
    the DNS-rebinding hole the whole file exists to close.

38. **The consent screen's wording is part of the plugin boundary, not copy.**
    Every sentence a grant is described by lives in `internal/plugin/describe.go`,
    beside the guard that enforces it, and a fetch allowlist entry is expanded
    into worked examples generated from `hostAllowed` itself. Do not write
    capability copy in `web/`: a screen that composes its own sentences will
    drift from the rule the host applies, and an operator will be consenting to
    something else. `TestExplanationsMatchTheGuard` and the
    `guard-mutation.sh` leg that breaks the expansion are what hold that line.
    Approval of a widening upgrade is never a default, autofocused or
    single-keystroke action, and installing always carries an explicit
    `grantsAccepted`, which the server refuses to act without.

39. **`Admin.Uninstall` is not a louder `Disable`.** It cascades to a plugin's
    key-value store and its encrypted secrets, which are unrecoverable, so it
    stays a distinct function and is refused while any session of a kind the
    plugin provides still exists. Never route a disable through it, and never
    delete a `session_kinds` row to get past the refusal — the sessions naming
    that kind are the reason the refusal exists. The refusal check, the
    retirement of the kinds it provided, the delete and the audit row are one
    transaction; do not split them back into separate round trips, and do not
    move the audit row onto the best-effort path the reversible actions use.

40. **A plugin install belongs to an org, and the admin gate does not enforce
    that.** `requireOrgAdmin` resolves the `{org}` in the *caller's own* path,
    so it proves only that they administer *an* org — never that they
    administer the one owning the id in the URL. Reach installs through
    `plugin.Store.InOrg(orgID)`, never through `Store` methods directly and
    never through a bare `select … from plugin_installs where id = $1`; the
    `Store`'s own unscoped methods exist for the host, which is acting on a
    plugin it is already running rather than on an id somebody typed. A
    foreign install answers **404, never 403** — `403` confirms the id exists,
    which is enough to enumerate what other tenants run.
    `TestOneOrgsAdminCannotTouchAnothersPlugin` and the `guard-mutation.sh`
    entry that strips the `org_id` filter from all three sites are what hold
    that line. The same rule applies to anything else that becomes per-org: an
    id in a URL is scoped by the request's org or it is not scoped at all.

41. **A session kind can arrive at runtime, and it belongs to an org.** The
    registry is no longer written only at wiring time: enabling a plugin
    install registers the kinds it provides and disabling or uninstalling one
    unregisters them, so `session.Registry` is copy-on-write behind an atomic
    pointer. Read it with `read()`; never index the map directly and never add
    a write path that mutates the live map instead of publishing a copy. A
    kind's `OrgID` is empty only for the core kinds, which are instance-wide —
    a plugin-provided kind carries the installing org, and the create path is
    `KnownInOrg`, not `Known`. `Known` stays org-blind on purpose: a room
    outlives the install that offered its kind, and loading one must not depend
    on whether a new one could be created. `Host.Sessions` reads a room through
    the same envelope the browser is sent, so the kind's own `StateFunc` is the
    only thing deciding what a plugin may see; never build a plugin's view of a
    room out of store rows.

42. **A ceremony delivered as a plugin may not bring a core commit with it.**
    `scripts/check-core-untouched.sh` is a CI leg: a pull request that touches
    `plugins/` fails if it also touches `internal/`, `cmd/` or `web/src`. The
    rule is one-directional — ordinary core work is untouched by it — because
    what it is testing is the claim the plugin system rests on, that the
    extension points are enough. If a plugin needs the host to change, that is a
    finding about the extension points and lands as its own pull request first;
    it is never folded into the plugin's. Do not widen the allowed set to get a
    branch green. The frontend is in the set on purpose: a ceremony that can only
    be rendered by editing `web/src/lib/kinds.ts` has been merged into Parley,
    not extended onto it.
43. **An inbound `X-Request-Id` is honoured only from a socket peer in
    `TrustedProxyCIDRs`.** `acceptTrustedRequestID` runs before
    `trustedProxyHeaders` rewrites `RemoteAddr`, so the peer checked is the TCP
    peer, not the forwarded client. Do not move it after the rewrite, and do not
    treat `TrustProxyHeaders` as sufficient on its own. Cap the value at 128
    printable ASCII characters so a hostile header cannot inject a newline into
    logs. `echoRequestID` exists because chi's `middleware.RequestID` does not
    set the response header. Security-event lines are `logSecEvent` in
    `internal/api/secevent.go` (and the matching `slog` call in
    `internal/api/custody/store.go`); do not log cookies, tokens, passcodes or
    bodies onto that line.
