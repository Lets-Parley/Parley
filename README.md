# Parley

**Planning poker and daily standups for your team, at your table.** Self-hosted,
open source, no accounts, no fuss.

[![ci](https://github.com/lets-parley/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/lets-parley/parley/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![go](https://img.shields.io/badge/go-1.26-00ADD8?logo=go&logoColor=white)](go.mod)
[![container](https://img.shields.io/badge/ghcr.io-parley-2496ED?logo=docker&logoColor=white)](https://github.com/lets-parley/parley/pkgs/container/parley)

**[www.letsparley.io](https://www.letsparley.io)** — the documentation:
[quickstart](https://www.letsparley.io/quickstart/),
[features](https://www.letsparley.io/features/),
[operations](https://www.letsparley.io/operations/),
[security](https://www.letsparley.io/security/), and a frank list of
[known limitations](https://www.letsparley.io/known-limitations/).

![A revealed planning poker round in Parley](docs/screenshot-poker.png)

## Contents

- [Why](#why)
- [Features](#features)
- [More screenshots](#more-screenshots)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Reverse proxy (HTTPS + WebSockets)](#reverse-proxy-https--websockets)
- [Kubernetes](#kubernetes)
- [Sign-in](#sign-in)
- [Security model](#security-model)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why

Most planning-poker tools want an account, a workspace, a seat count, and a
credit card before anyone can vote on a story. Parley wants a link.

One Go binary and a Postgres database. The frontend is compiled into the binary,
so there is no second service, no Node runtime in production, and nothing to
keep in sync. Point a container at a database and you have a table your team can
sit at.

## Features

### Planning poker

- **Story queue.** The facilitator adds work as a ticket (with a reference like
  `PLAT-412`) or as an ad-hoc line item, with optional notes, and controls its
  order and selection. Ordinary members retain their own votes.
- **Four decks:** Fibonacci, modified Fibonacci, T-shirt sizes, and powers of
  two. Every deck carries `?` and a coffee card.
- **Hidden votes.** Nobody sees a value until the round opens, which happens
  automatically once everyone at the table has voted, or when the facilitator
  calls it.
- **Stats that suit the deck.** Median up front, per-value counts underneath,
  average only when the deck is numeric. A T-shirt round reports mode and range
  instead of inventing a meaningless "M-and-a-half".
- **Save the estimate:** one click writes the agreed number onto the story and
  moves the queue along.
- **Spectators** can step back from the table and watch without holding up the
  round. They don't count toward the auto-reveal.

### Daily standup

- **Round-robin order** with a 90-second-per-person timer, so the quiet people
  get their turn and the talkative ones can see the clock. The room shows whose
  turn it is and how long is left; the length is a session setting no UI edits
  yet.
- **Skip / absent** without losing anyone's place in the rotation.
- **Yesterday writes itself.** Whatever you put in "today" last standup is
  waiting in "yesterday" at the next one.
- **Write ahead.** Fill your entry in before the meeting; it saves itself as you
  type, and an incoming update from someone else can't eat your keystrokes.
- **Blockers roundup** at the end, ready to copy into a channel.

### Spaces

- **One memorable link per team.** `/s/platform-team`, and that's the URL you
  paste in chat.
- **Protected by default.** New spaces get a six-character passcode. People
  enter the code, pick a name, and they're in. Any member can
  mint a new code, or open the space so the link alone is the invite.
- **Roster with presence:** who's around, who's in a session, and a jump
  straight to the table they're sitting at.
- **Customizable avatars.** Pick one of thirty voxel-art portraits, and it
  follows you through the roster, the table, and every standup.
- **Session history**, searchable by title and filterable by kind, with a
  most-recent / active-first / A–Z sort.

### Everything else

- **No accounts, or your accounts.** A name and a cookie by default; point
  `AUTH_MODE=oidc` at any OpenID Connect provider and people sign in with the
  identity they already have.
- **Live for everyone.** WebSocket-backed, with shared-store session
  revalidation at least every 30 seconds and a reconnect banner that tells the
  truth about the connection instead of silently going stale.
- **CSV export** for any session: estimates, votes per person, standup entries.
  Cells that start with `=` are escaped, so an export can't run formulas in a
  spreadsheet.
- **Facilitator takeover.** If the facilitator drops off, anyone at the table
  can claim the role after a 60-second grace period, and the room is told who
  did. The button is in the poker room today; standup rooms have the endpoint
  but no control yet, as does explicit hand-off to a named person.
- **Light, dark, and system themes.**
- **Boring to operate.** `/healthz` that never touches the database, `/readyz`
  that checks both Postgres and this replica's cross-replica listener, structured JSON logs, migrations applied at boot, and a refusal to
  start rather than run against a database a newer version has already migrated.

## More screenshots

| | |
|---|---|
| ![Standup in progress](docs/screenshot-standup.png) | ![The space page](docs/screenshot-space.png) |
| A standup mid-rotation, timer running | Sessions, roster, and the passcode |

![The same round in dark mode](docs/screenshot-poker-dark.png)

## Quickstart

### On your own machine

Two files, no checkout. Publishing an exact semantic-version GitHub Release
builds a multi-arch image (amd64 and arm64) at
`ghcr.io/lets-parley/parley`, and the compose file pulls it.

```sh
mkdir parley && cd parley
base=https://raw.githubusercontent.com/lets-parley/parley/main
curl -fsSLo docker-compose.yml $base/docker-compose.yml
curl -fsSLo .env $base/.env.example   # set POSTGRES_PASSWORD to anything
docker compose up -d
```

To build from source instead, clone the repo and swap the commented `build:`
line into `docker-compose.yml` for the `image:` line above it.

Open http://localhost:8080 — you should see the Parley landing page. Name a
space, share nothing yet: it's bound to localhost.

### On a server, shared with your team

Two changes, made together:

1. In `docker-compose.yml`, change the port binding from `127.0.0.1:8080:8080`
   to `0.0.0.0:8080:8080` (or better, keep it and put a reverse proxy in
   front — see below).
2. In `.env`, set `BASE_URL` to the address your teammates will use, e.g.
   `BASE_URL=http://192.168.1.10:8080` or `https://parley.example.com`.

`BASE_URL` drives the WebSocket origin check and the session cookie's Secure
flag; if it doesn't match how people actually reach the server, boards will
sit at "reconnecting" or logins won't stick (see Troubleshooting).

`AUTH_MODE=open` is for a trusted network. A public deployment needs a space
passcode or an external SSO/authentication proxy plus request and connection
abuse controls at the ingress.

### Against a Postgres you already run

Skip compose entirely and point the image at your own database:

```sh
docker run -d --name parley -p 8080:8080 \
  -e DATABASE_URL='postgres://parley:secret@db:5432/parley' \
  -e BASE_URL='https://parley.example.com' \
  ghcr.io/lets-parley/parley:0.6.1
```

Pin a version rather than `latest` — 0.6.1 is the current release. 0.2.2 is the
security floor: every earlier release can be crashed remotely by a disconnecting
client.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `BASE_URL` | no | `http://localhost:8080` | The address users reach Parley at. Drives cookie `Secure` and the WebSocket origin check. |
| `PORT` | no | `8080` | Listen port |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |
| `TRUST_PROXY_HEADERS` | no | `false` | Trust canonical `X-Forwarded-For` only from allowlisted proxy hops — see below |
| `TRUSTED_PROXY_CIDRS` | with proxy trust | — | Comma-separated CIDRs for every trusted immediate/intermediate proxy hop |
| `POD_NAME` | no | random per process | Names this instance on the rows recording who is in a room, so a row that outlives the process it came from can be traced back to it. On Kubernetes the chart fills it from the pod name; nothing else needs to set it |
| `IDENTITY_IP_HOURLY_LIMIT` | no | `10` | Open-mode identity creations per verified client address per hour |
| `IDENTITY_GLOBAL_HOURLY_LIMIT` | no | `500` | Open-mode identity creations across the instance per hour |
| `SPACE_LIMIT_PER_IDENTITY` | no | `50` | Spaces an identity may create |
| `SESSION_LIMIT_PER_SPACE` | no | `500` | Sessions a space may contain |
| `STORY_LIMIT_PER_SESSION` | no | `500` | Stories a planning-poker session may contain |
| `AUTH_MODE` | no | `open` | `open` for no accounts, `oidc` to sign in through an identity provider |
| `OIDC_ISSUER` | with `oidc` | — | Issuer base URL, the one serving `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` | with `oidc` | — | Client ID registered with the provider |
| `OIDC_CLIENT_SECRET` | no | — | Client secret. Leave unset for a public-client registration; PKCE carries the flow either way |
| `OIDC_SCOPES` | no | `profile email` | Extra scopes; `openid` is always requested |

Boot logs print the derived settings (`cookie_secure`, `allowed_ws_origin`)
so a misconfiguration is visible in the first three lines.

## Reverse proxy (HTTPS + WebSockets)

**Caddy** needs one line — it handles WebSockets and TLS automatically:

```
parley.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx** needs the upgrade headers and a read timeout longer than a quiet
standup speaker (Parley pings every 25s, so 75s is safe):

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

Set `BASE_URL=https://parley.example.com` to match. If the proxy is the only
path to Parley, set both `TRUST_PROXY_HEADERS=true` and
`TRUSTED_PROXY_CIDRS=127.0.0.1/32` for the same-host examples above. Use the
actual proxy network instead when it connects from another address.

Get this one the right way round, because it is wrong in both directions:

- **Directly reachable, trust enabled** — only peers in `TRUSTED_PROXY_CIDRS`
  can supply an address. Do not include client-reachable networks in that list.
- **Behind a proxy, left `false`** — every visitor arrives wearing the proxy's
  address, so the throttle counts them all as one client and eight wrong
  guesses lock the whole internet out of that space for a minute.
- **Several proxy hops** — list every hop CIDR. Parley walks
  `X-Forwarded-For` right-to-left through trusted hops and selects the first
  untrusted address. Malformed chains and headers from untrusted immediate
  peers are ignored; `X-Real-IP` and `True-Client-IP` are never used.

Both `deploy/k8s/deployment.yaml` and `docker-compose.yml` default it to `false`.
Enable it only after replacing the example topology with your proxy CIDRs.

## Kubernetes

Parley ships no Postgres here, so four things must be true before you install,
each of them otherwise a `CrashLoopBackOff` with a `FATAL:` log line:

- **PostgreSQL 13 or newer.** The first migration runs
  `create extension if not exists pgcrypto`, which is only a *trusted* extension
  from 13 onward — any role with `CREATE` on the database can install it there,
  no ownership or superuser needed.
- **The database and the role already exist**, and the role in `DATABASE_URL`
  has `CREATE` on the database (`GRANT CREATE ON DATABASE parley TO parley;`).
  Parley creates its schema, not the database and not the role.
- **`?sslmode=require`** on the URL if your Postgres requires TLS. Without it the
  handshake is refused and you get a minute of retries, then a restart.
- **The secret holds one key** — default `database-url` — whose value is the
  whole connection URI. A secret split into `username`/`password`/`host` keys
  gives `CreateContainerConfigError`. The OIDC secret is the same shape, under
  `oidc-client-secret`.

Then:

```sh
kubectl create secret generic parley \
  --from-literal=database-url='postgres://parley:secret@host:5432/parley?sslmode=require'

helm install parley oci://ghcr.io/lets-parley/charts/parley --version 0.6.1 \
  --set database.existingSecret=parley \
  --set baseURL=https://parley.example.com
```

Pin `--version`. Without it Helm resolves to whatever the registry currently
calls newest, so the same command gives you a different Parley next month.

It refuses to render rather than hand you a deployment that cannot work: a
moving image tag, a fractional replica count, a missing database secret, OIDC
with neither `auth.oidc.existingSecret` nor `auth.oidc.publicClient` chosen, or
ingress TLS under an `http://` base URL all fail at `helm template` time with a
message saying why. A public client is a supported registration — Parley uses
PKCE — but which one you have has to be said out loud, so a values merge that
drops the secret cannot quietly turn a confidential client into a public one. `helm test` then checks the
Service actually routes to a pod that is ready — which means it reached Postgres
*and* is holding the `LISTEN` it hears other replicas on. It fails if either is
down.

`deploy/k8s/deployment.yaml` (in this repo — clone it, or fetch that one file)
is the same thing as a plain manifest, for people who do not run Helm. It reads
the same `parley` secret, so create that first and then:

```sh
kubectl apply -f deploy/k8s/deployment.yaml
```

Two things in it are load-bearing rather than stylistic. `strategy:
RollingUpdate` with `maxUnavailable: 0`, so a rollout never drops below the
replica count. And the liveness probe hits `/healthz`, which never touches the
database, because a DB blip must not restart the pod and drop every WebSocket.

Parley runs on more than one replica: WebSocket fanout goes through Postgres
`LISTEN`/`NOTIFY`, presence and the room-code throttle are rows in Postgres, and
pods that boot together serialize their migrations behind an advisory lock. The
chart defaults to one replica, so an upgrade never doubles a running install's
pods behind your back; `--set replicaCount=2` opts in. This needs **chart 0.4.1 or
newer** — every published chart before it refuses `replicaCount > 1` at render
time, so pass `--version 0.6.1` when you scale up. Above one replica the
chart also renders a PodDisruptionBudget and a topology spread constraint — a
budget in front of a single pod would deadlock the drain it was meant to
survive. Each replica opens up to 10 pooled Postgres connections plus one for
the fanout listener, so size `max_connections` for `replicas × 11` (12 per pod
briefly at boot, while it holds the migration lock on its own connection).

One thing to expect during a rollout: the new pod migrates the database before
the old pods are gone, so the old version briefly serves against a newer schema.
Migrations are additive, so it keeps working, and an old pod that restarts in
that window comes back normally and is replaced moments later. Roll forward —
rolling back onto an image older than the migrations that have run is refused,
by design.

## Sign-in

Parley runs in one of two modes, set by `AUTH_MODE` and fixed at boot.

**`open`** is the default and the original: no accounts at all. People type a
name and take a seat. Nothing to administer, nothing to
provision, and a stranger with the link and the passcode is a participant.

**`oidc`** hands sign-in to your identity provider. There is no vendor-specific
code in Parley — it is a plain OpenID Connect relying party that reads the
issuer's discovery document, so anything speaking OIDC works and switching
providers is a change of configuration:

```sh
AUTH_MODE=oidc
OIDC_ISSUER=https://keycloak.example.com/realms/yourteam
OIDC_CLIENT_ID=parley
OIDC_CLIENT_SECRET=...   # omit for a public client
```

Register `<BASE_URL>/auth/callback` as the redirect URI with your provider, and
allow the `openid`, `profile`, and `email` scopes. Sign-in uses the
authorization code flow with PKCE; the ID token's signature, audience, expiry,
and nonce are all verified before an account is touched.

Two things worth knowing before you switch a running instance:

- **The anonymous door closes.** With a provider configured, the endpoint that
  mints a nameless identity is refused outright — otherwise signing in would be
  optional and therefore pointless.
- **Everyone is signed out.** Sessions created while the instance was open stop
  being accepted the moment it starts in `oidc` mode — otherwise turning
  sign-in on would change nothing for anyone already holding a cookie. Their
  accounts and rooms stay in the database, untouched and unmigrated, but the
  people behind them come back as new federated accounts. There is no account
  linking yet, so old votes and entries remain attributed to the old display
  records. Federated users can rejoin an existing space with its passcode.

Names come from the provider's claims — `name`, then `preferred_username`, then
the local part of `email` — and refresh on every sign-in, so a rename upstream
follows the person onto the roster. Signing out ends the Parley session only; it
does not sign anyone out of the identity provider.

## Security model

In `open` mode Parley has **no user accounts**. A space is guarded by a shared
passcode, not by identity: anyone holding the code can join, see the roster,
vote, and write their own standup entry. Joins are broadcast to the room, so
lurking is visible. Open mode is trusted-network-only. A public deployment
needs a passcode or an external SSO/authentication proxy in front of the whole
instance, plus ingress abuse controls.

Passcodes work the same either way. Identity says who you are; the code says
which room you may enter. Signing in does not by itself get anyone into a
space — per-user and per-team access to a space is still on the roadmap.

Passcodes are six characters from a 25-character alphabet, and wrong guesses
are throttled per client address. They are stored **readable** in the database
on purpose: a passcode is meant to be read off the space page by any member
and passed on, the way a Meet or Zoom code is, so hashing it would only mean
nobody could ever see it again. Treat a database dump as disclosing the room
codes of every space — but not any member's identity. Session cookies remain
opaque random tokens stored hashed, so a backup still contains no credentials
that impersonate a person. Any member can mint a new code (retiring the old
one) or open the space entirely.

What Parley does enforce: acting in a space requires having joined it; a
protected space refuses joins without the code; session existence is never
disclosed to non-members; story creation, editing, reordering, selection and
deletion plus session controls are facilitator-only and server-checked; active
WebSockets close with policy code 1008 when their shared-store token is revoked
or expires.

Found something? Use
[private vulnerability reporting](https://github.com/lets-parley/parley/security/advisories/new)
when available, or email
[security@letsparley.io](mailto:security@letsparley.io), rather than opening a
public issue.

## Backups

```sh
docker compose exec db pg_dump -U parley parley > parley-backup.sql
```

Restore into a fresh stack:

```sh
docker compose up -d db
cat parley-backup.sql | docker compose exec -T db psql -U parley parley
docker compose up -d
```

> **Warning:** `docker compose down -v` **deletes the data volume** — your
> spaces, estimates, and history. Plain `down` is safe.

## Upgrading

**Parley:** back up the database first — migrations are forward-only and there
is no down path. Then bump the tag in `docker-compose.yml` and `docker compose
pull && docker compose up -d`. Migrations run automatically at boot. Rolling *back* an image is only safe if the newer
version didn't add migrations — if it did, Parley refuses to start with a
message telling you so; restore from backup instead.

**On Kubernetes:** re-run the install as an upgrade, pinning the new chart
version and keeping the values you set the first time, then confirm the pods
actually rolled rather than assuming they did:

```sh
helm upgrade parley oci://ghcr.io/lets-parley/charts/parley --version 0.6.1 \
  --reuse-values
kubectl rollout status deploy/parley
helm test parley
curl -s https://parley.example.com/version
```

Under ArgoCD or Flux, neither `--reuse-values` nor `helm test` exists, and
`helm template` prints none of the chart's `NOTES.txt` warnings — the
[GitOps notes](https://www.letsparley.io/operations/gitops/) cover what to do
instead.

**Postgres:** the compose file pins `postgres:16-alpine` on purpose. Major
Postgres upgrades (16 → 17) are not automatic: `pg_dump` with the old
version, start fresh with the new one, restore. Never just change the tag on
an existing volume.

## Troubleshooting

- **`docker compose up` fails with `set POSTGRES_PASSWORD in .env`.** Copy
  `.env.example` to `.env` and set a password. There is no default database
  password, on purpose.
- **Permanent "reconnecting" banner.** The WebSocket origin check is rejecting
  your browser. Set `BASE_URL` to the exact address in your address bar (scheme,
  host, and port) and restart. Behind nginx, also confirm the Upgrade/Connection
  headers from the snippet above.
- **You set a name but every refresh forgets you.** `BASE_URL` is `https` but
  you're browsing over plain `http`, so the browser drops the Secure cookie.
  Serve over HTTPS or set an `http` BASE_URL.
- **`/readyz` fails but `/healthz` is fine.** Usually the app is up and Postgres
  isn't — check the `db` container and `DATABASE_URL`. If Postgres is healthy,
  the other cause is that this instance lost its listener for cross-instance
  session changes; it reconnects on its own, and the log line naming the
  reconnect says so.
- **"That passcode doesn't match this space".** Codes are six characters and
  case-insensitive; spaces and hyphens are ignored. After eight wrong tries
  from one address, wait a minute before trying again.
- **Nobody can start the standup.** The rotation is built from whoever has the
  session open, so everyone joins first, then the facilitator starts.

## Development

```sh
cd web && npm install && npm run build && cd ..   # embedded assets
go test -p 1 ./...                                # unit tests
TEST_DATABASE_URL=postgres://... go test -p 1 ./...  # + integration tests
cd web && npm run dev                             # Vite dev server, proxies /api and /ws to :8080
```

`-p 1` matters: the integration tests share one database and migrate it, so
running packages in parallel makes them fight over the schema.

### Layout

| Path | What lives there |
|---|---|
| `cmd/parley` | main — config, boot, graceful shutdown |
| `internal/api` | HTTP router, identity, spaces, sessions, passcodes |
| `internal/poker`, `internal/standup` | the session kinds |
| `internal/session` | the registry the kinds plug into, plus CSV |
| `internal/hub` | WebSocket fan-out and presence |
| `internal/store` | Postgres queries |
| `internal/db/migrations` | numbered SQL, applied at boot |
| `web` | Vite + React frontend, embedded into the binary |

Session kinds are self-contained packages registered into a `session.Registry`
in `internal/api/router.go`. Adding one takes three steps — the package, a
migration seeding its `session_kinds` row, and an entry in
`web/src/lib/kinds.ts` — written up in
[Adding a session kind](https://www.letsparley.io/project/contributing/#adding-a-session-kind).

## Roadmap

Nothing is promised, and the order will change. [ROADMAP.md](ROADMAP.md) has the
direction — Now, Next, Later, and what is still only being explored — and the
[project board](https://github.com/orgs/Lets-Parley/projects/1) has the detail.

Next up is making session kinds a real extension point, so the ceremonies after
poker and standup are code someone adds rather than surgery on the core.

## Contributing

Questions and early designs belong in
[Discussions](https://github.com/lets-parley/parley/discussions); Issues track
accepted, actionable work. Pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and the
[Code of Conduct](CODE_OF_CONDUCT.md).

A few things that make review quick:

- Open an issue before a large change, so nobody builds the wrong thing twice.
- `go test -p 1 ./...`, `npm test` and `npm run lint` pass.
- A behaviour change comes with a test that fails without it.
- Migrations are additive and numbered; never edit one that has shipped.
- Every commit carries a DCO sign-off created with `git commit -s`.

## License

[MIT](LICENSE)
