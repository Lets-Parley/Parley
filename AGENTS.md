# AGENTS.md

Operating notes agents (and people) cannot infer from the code alone.
Style, testing philosophy, and lint policy live in
[CODE_STANDARDS.md](CODE_STANDARDS.md). Contribution process (DCO, commits,
branches, skip-flag parsing) lives in [CONTRIBUTING.md](CONTRIBUTING.md).

Parley is one Go binary plus Postgres. The Vite React app under `web/` is
embedded (`go:embed`); there is no Node runtime in production. Docs are
`site/`; WASM ceremonies are `plugins/`; deploy charts are under `deploy/`.

## Before you edit

1. Read [CODE_STANDARDS.md#working-rules](CODE_STANDARDS.md#working-rules).
2. Read every matching row in [Routing](#routing) below.
3. For Go/frontend/test/lint work, open the matching CODE_STANDARDS sections
   named in working-rules (`#go-format`, `#ts-style`, `#testing`,
   `#lint-policy`, …).

## Commands

```sh
cd web && npm ci && npm run build && cd ..   # REQUIRED before go build/test
export DATABASE_URL=postgres://parley:dev@localhost:5432/parley
go run ./cmd/parley
```

Frontend hot reload: `cd web && npm run dev` (proxies `/api` and `/ws` to
`:8080`). Skipping the npm build fails Go embed (`all:dist`); a stale `dist`
compiles while serving an old UI. `DATABASE_URL` has no default.

Bounded verification recipes (memory/workers):
[CODE_STANDARDS.md#test-resources](CODE_STANDARDS.md#test-resources).

## Testing traps

```sh
export TEST_DATABASE_URL=postgres://test:test@localhost:5432/test
go vet ./...
go test -p 1 -race ./...
cd web && npm run lint    # oxlint; also runs in the CI `web` job
```

`-p 1` is mandatory (shared test DB). Without `TEST_DATABASE_URL`, DB tests
**fail** (they do not skip). `PARLEY_SKIP_DB_TESTS=1` is the only opt-out; CI
rejects it and any skipped test. Parser details:
[CONTRIBUTING.md](CONTRIBUTING.md). Report whether the DB was set.

An `api.Options` field is dead unless `main` maps it — handler tests that
build their own `Options` stay green. Cover wiring from `cmd/parley`
(`plugin_wiring_test.go`). Detail: [docs/agents/ship.md#env](docs/agents/ship.md#env).

## Verify

Local: commands above plus `cd web && npm test` when changing frontend.
CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (`go` runs race
tests and embeds via `npm test`; `go-fips` omits race; `web` runs oxlint).
A new required job needs scheduling **and** a success assertion on `gate`.
CodeQL is a separate workflow. Always say what you ran and whether
`TEST_DATABASE_URL` / skip opt-out were set.

## Routing

Before edits, follow **every** matching row. Read complete named sections
(or the whole child if the change spans it).

| When the task touches | Read |
| --- | --- |
| Migrations, embed/`web/dist`, Docker/ignore, boot/env, health/OIDC, releases/screenshots, dependency bumps | [docs/agents/ship.md](docs/agents/ship.md) |
| Routes, auth, org/space lookups, signed links, custody, hub/presence, space URLs, proxy/request-ID | [docs/agents/http.md](docs/agents/http.md) |
| Plugin host/SDK/ceremony, frames/consent, session kinds/`StateFunc`, room actions, `broadcastLocal` | [docs/agents/plugins.md](docs/agents/plugins.md) |

Foreign plugin-admin routes need
[http.md#tenancy](docs/agents/http.md#tenancy) **and**
[plugins.md#install-org](docs/agents/plugins.md#install-org).
A core `StateFunc` edit needs [plugins.md#kinds](docs/agents/plugins.md#kinds).
New routes need CSRF, guest/embedded, and tenancy classification together.

## Security

Preserve tenant/guest/admin/redaction/credential/plugin/recovery invariants.
See [docs/security/README.md](docs/security/README.md), the Parley security
skill, and [integrations](site/src/content/docs/security/integrations.mdx).
Update affected evidence after a boundary change.

## Refusals

One-line refusals; mechanisms are in the linked anchors.

1. [Migrations](docs/agents/ship.md#migrations): append-only; never edit/renumber shipped SQL.
2. [Embed](docs/agents/ship.md#embed): never hand-edit `web/dist/**`.
3. [Replicas](docs/agents/ship.md#replicas): new advisory lock → new id (`migrationLockID` taken).
4. [BASE_URL](docs/agents/ship.md#base-url): cookie `Secure` + WebSocket origin.
5. [Proxy](docs/agents/ship.md#proxy): `TRUST_PROXY_HEADERS` default false.
6. [CSRF](docs/agents/http.md#csrf): `/api` only; new top-level groups state their own story.
7. [Health](docs/agents/ship.md#health): `/healthz` never touches DB; `/readyz` does.
8. [OIDC](docs/agents/ship.md#oidc): discovery off startup/readiness path.
9. [Image](docs/agents/ship.md#image): no stage after default runtime; Postgres 16; no `fips140=only`.
10. [Docs stamp](docs/agents/ship.md#docs-stamp): change default/limit/security → update `site/` (+ stamp).
11. [Release pins](docs/agents/ship.md#release-pins): bump via `scripts/bump-release-pins.sh`, then tag.
12. [Link FK](docs/agents/http.md#link-fk): `users.link_id` is `ON DELETE SET NULL`.
13. [Route class](docs/agents/http.md#route-class): classify every new route for link guests + embedded.
14. [Link expiry](docs/agents/http.md#link-expiry): honour `session_tokens.expires_at` in resolve and expiry.
15. [Hub](docs/agents/http.md#hub): DB callbacks via `hub.track`; presence before initial frame.
16. [Slug](docs/agents/http.md#slug): slug unique per org; lookups carry org.
17. [Link users](docs/agents/http.md#link-users): “every user” backfills exclude link holders.
18. [Revocation](docs/agents/http.md#revocation): `GrantMember` never clears `revoked_at`.
19. [Org param](docs/agents/http.md#org-param): org from `orgFrom(ctx)` after `requireOrgMember`.
20. [Tenancy](docs/agents/http.md#tenancy): org membership ≠ space org; foreign slug → 404.
21. [One query](docs/agents/http.md#one-query): anonymous space landing stays `BySlugInOrg`.
22. [No org prefix](docs/agents/http.md#no-org-prefix): session tree + link redeem stay unscoped.
23. [Paths](docs/agents/http.md#paths): space URLs from `web/src/lib/paths.ts`.
24. [Legacy slug](docs/agents/http.md#legacy-slug): `/s/{slug}` only caller's orgs; 302.
25. [Visibility](docs/agents/http.md#visibility): listing ≠ entry; don't cross-write passcode/visibility.
26. [Custody](docs/agents/http.md#custody): management without access; four clauses.
27. [Revoke](docs/agents/http.md#revoke): last-owner promote or write nothing; tombstone upsert.
28. [Audit FK](docs/agents/http.md#audit-fk): `org_audit_log` FKs `ON DELETE SET NULL`.
29. [Purge](docs/agents/http.md#purge): one transaction; confirm=slug; refuse default org.
30. [Env](docs/agents/ship.md#env): every env key in config docs **and** chart values.
31. [Screenshots](docs/agents/ship.md#screenshots): update `screenshots.json`; unreadable manifest fails.
32. [Delivery](docs/agents/plugins.md#delivery): plugin path at-least-once → idempotent handlers.
33. [Dependencies](docs/agents/ship.md#dependencies): Dependabot only `site/`; Go/`web` hand-bumped.
34. [Dockerignore](docs/agents/ship.md#dockerignore): globs match source paths too.
35. [Mutation](docs/agents/plugins.md#mutation): new sandbox guard → `guard-mutation.sh` sites.
36. [Frame](docs/agents/plugins.md#frame): `/plugin-ui` chi group never gets `X-Frame-Options: DENY`.
37. [Projection](docs/agents/plugins.md#projection): frame sees only `redactSession` output.
38. [Grants](docs/agents/plugins.md#grants): check capabilities from `Store.State` every host call.
39. [Fetch](docs/agents/plugins.md#fetch): dial the screened address on every redirect hop.
40. [Consent](docs/agents/plugins.md#consent): consent copy in `describe.go`; need `grantsAccepted`.
41. [Uninstall](docs/agents/plugins.md#uninstall): not Disable; one transaction with refusal/audit.
42. [Install org](docs/agents/plugins.md#install-org): `InOrg`; foreign install **404**, never confirms id.
43. [Kinds](docs/agents/plugins.md#kinds): COW registry; `KnownInOrg` create; client-safe `StateFunc`.
44. [Core untouched](docs/agents/plugins.md#core-untouched): `plugins/` PR must not touch core/`web/src`.
45. [Request-ID](docs/agents/http.md#request-id): honor `X-Request-Id` only from trusted TCP peer.
46. [Refusal](docs/agents/plugins.md#refusal): `{"refused"}` ≠ breaker failure; keep counters separate.
47. [Action order](docs/agents/plugins.md#action-order): room line → slot → two-key lock; unlock before broadcast.
48. [Module](docs/agents/plugins.md#module): `unuse` cached modules; compile under `Host.compiles`.
49. [Broadcast](docs/agents/plugins.md#broadcast): `broadcastLocal` mutex; may skip.

Unnumbered: kind configs `DisallowUnknownFields`; `StateFunc` returns only
client-safe data — [plugins.md#kinds](docs/agents/plugins.md#kinds).

## Owners

Update root refusal + child mechanism in the same PR. Structural check:
`scripts/check-agents-budget.sh`. A new child needs measured read-cost benefit
and a routing-table update in the same change. Commits/PRs:
[CONTRIBUTING.md](CONTRIBUTING.md).
