# Ship

Read the sections that match the change: migrations, the embedded frontend, image and ignore rules, boot and configuration mapping, health and the OIDC probe, releases, screenshots, or dependency bumps. Configuration mapping includes the composition-root wiring from the root testing notes.

<a id="migrations"></a>

## Migrations are append-only

`internal/db/migrations/*.sql` are embedded and versioned by filename sort order. Prefixes are numeric, so that order is the version. Never edit or renumber a shipped migration — the running database has already applied it. The binary refuses to start if the database is ahead of it (`internal/db/migrate.go`).

<a id="embed"></a>

## `web/dist` is build output

Never hand-edit `web/dist`. `web/embed.go` declares `//go:embed all:dist`, and nothing under `web/dist/` is tracked. A fresh tree has no `dist` directory: skipping the npm build makes Go compilation fail (`pattern all:dist: no matching files found`). A stale `dist` compiles and serves the old UI.

<a id="replicas"></a>

## Parley runs on more than one replica

Fan-out, presence, and the passcode throttle all go through Postgres. `db.Migrate` serializes simultaneous boots behind an advisory lock (`migrationLockID`). The WebSocket hub is still in-process. It is per pod, and it is no longer authoritative for anything. A new advisory lock gets its own id. A blocking lock on an id the process already holds deadlocks every boot. Room actions take a different lock class; see [plugins.md#action-order](plugins.md#action-order).

<a id="base-url"></a>

## `BASE_URL` is security config

`BASE_URL` drives the WebSocket origin check and whether the session cookie is `Secure`. Claiming `https` while serving plain HTTP makes sign-in appear to work and then fail to persist.

<a id="proxy"></a>

## `TRUST_PROXY_HEADERS` defaults to false

`TRUST_PROXY_HEADERS=true` without a real proxy in front is a vulnerability: clients can forge `X-Forwarded-For` and defeat the room-code throttle. Leave the default false. Trusting the proxy does not by itself authorize an inbound `X-Request-Id`; see [http.md#request-id](http.md#request-id).

<a id="health"></a>

## `/healthz` never touches the database

`/readyz` does. A database blip that restarted the process would drop every live WebSocket. Preserve the split.

<a id="oidc"></a>

## OIDC discovery stays off startup and readiness

OIDC discovery is probed in the background at boot. It does not gate startup or readiness. A failed probe is retried during sign-in, so a broken identity provider cannot stop the server from starting.

<a id="image"></a>

## The default image is the last `FROM`

The image build uses Docker. Do not switch it to Podman. The final image is distroless and runs as nonroot. The container healthcheck is the binary itself (`/parley -healthcheck`). Postgres is pinned to `16-alpine` — an unplanned major upgrade breaks the data directory. The default image is the last `FROM` in the Dockerfile. The FIPS variant is `--target fips` (`GOFIPS140=v1.0.0`, `GODEBUG=fips140=on`). Do not append a stage after the default runtime: `docker build` without `--target` would become the FIPS image, and every CI job would pay for it. `fips140=only` is not used. RFC 6455 SHA-1 for the WebSocket accept key panics under it.

<a id="docs-stamp"></a>

## Changed defaults, limits, and security properties update the site page

A docs page that carries a `VerifiedStamp` records the version and the source file it was transcribed from. Changing a default, limit, or security property means updating the `site/` page and its stamp, when that page has one, in the same pull request.

<a id="release-pins"></a>

## Release pins go through the bump script, then the tag

The docs site writes the current release down once, in `site/src/version.mjs`. Pages carry `%VERSION%`, and an mdast plugin substitutes it at build time, in prose and in code fences. A push under `site/**` is also what redeploys the site, because `release.yml` does not touch `site/`. Leave minimum-version sentences ("chart 0.4.1 or newer") and historical references literal. They are not the current version.

A release runs `scripts/bump-release-pins.sh X.Y.Z`. Do not hand-edit that line. The same version is named in the README, `SECURITY.md`, the compose file, the Kubernetes manifest, the Helm chart, and the deployment guide's FIPS example. `scripts/check-release-pins.sh` fails a partial bump. `scripts/check-release-freshness.sh` fails a `version.mjs` left behind a tag. Bump first, tag second: merge the bump pull request, then run `scripts/cut-release.sh X.Y.Z`, which refuses unless `origin/main` already pins `X.Y.Z`. The steps are [Cutting a release](../../site/src/content/docs/project/contributing.mdx#cutting-a-release).

<a id="env"></a>

## Every environment variable is named in both operator-facing places

`TestEveryEnvironmentVariableIsDocumented` walks non-test Go under `cmd/` and `internal/` and requires each key it can read to appear in `site/src/content/docs/reference/configuration.mdx` and in `deploy/charts/parley/values.yaml`. It resolves the callee rather than grepping for `os.Getenv`, because most configuration goes through `envOr` and a literal `os.Getenv` scan covers eight keys out of twenty-two. Register a new reader in `envReaders` (`cmd/parley/config_documented_test.go`). A key that only an unregistered helper reads is invisible, and a name in that map that is never called fails the test. `cmd/parley/env_keys_allowlist.txt` holds only keys no scan of the Go source can find. An entry the scan can find is an error, so the list cannot accumulate. Finding zero keys is a fatal failure.

A feature gated on an `api.Options` field is dead unless `main` sets it, and no handler test can tell you that. Every test in `internal/api` constructs its own `Options`, so a handler is exercised with the field populated and passes, while the shipped binary takes the zero value. `PLUGIN_DIR` shipped that way: parsed, logged, and handed to the WASM runtime, and never put in the `api.Options` literal, so the plugin UI answered 404. When you add an `Options` field, wire it in `cmd/parley/main.go`'s `apiOptions` and cover it in `cmd/parley/plugin_wiring_test.go`. That test drives a real router built from the mapping and enumerates every exported field, so the next absent wire fails. The same shape applies to any configuration that reaches a subsystem through a struct literal in `main`.

<a id="screenshots"></a>

## Screenshots go stale silently

`site/src/assets/screenshots.json` maps each shipped screenshot to the `web/src` files it depicts and the commit it was last shot against. `scripts/check-screenshot-freshness.sh` reports the drift, and CI surfaces it on any pull request touching `web/src`. The drift itself is advisory and does not fail the job. A manifest the checker cannot read exits nonzero, because a report that claims the set is fresh has to mean the checker looked. `depicts` paths are literal and must exist at `HEAD`. An empty list, or a path naming a file that is gone, is reported rather than counted clean. When you re-shoot, move `shot_at`. When you add a shot, add it to the manifest.

<a id="dependencies"></a>

## Dependabot watches only `site/`

Go modules and `web/` dependencies are bumped by hand, with tests.

<a id="dockerignore"></a>

## `.dockerignore` matches source paths

`.dockerignore` patterns match source paths as well as real secrets. `**/secrets*` matched `internal/plugin/secrets.go` and dropped it from the Docker build context, so `plugin` lost symbols another file in the package referenced. A red `docker build and smoke` beside a green `go` check on the same commit means a file was excluded from the image build. Diff `.dockerignore` against the pull request's new filenames before chasing the missing symbol.
