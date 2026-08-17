# Parley

**Planning poker and daily standups for your team, at your table.** Self-hosted,
open source, no accounts, no fuss.

[![ci](https://github.com/jacorbello/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/jacorbello/parley/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![go](https://img.shields.io/badge/go-1.26-00ADD8?logo=go&logoColor=white)](go.mod)
[![container](https://img.shields.io/badge/ghcr.io-parley-2496ED?logo=docker&logoColor=white)](https://github.com/jacorbello/parley/pkgs/container/parley)

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

- **Story queue.** Add work as a ticket (with a reference like `PLAT-412`) or as
  an ad-hoc line item, with optional notes. Reorder with the arrows.
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

- **Round-robin order** with a per-person timer, so the quiet people get their
  turn and the talkative ones can see the clock.
- **Skip / absent** without losing anyone's place in the rotation.
- **Yesterday writes itself.** Whatever you put in "today" last standup is
  waiting in "yesterday" at the next one.
- **Write ahead.** Fill your entry in before the meeting; it saves itself as you
  type, and an incoming update from someone else can't eat your keystrokes.
- **Blockers roundup** at the end, ready to copy into a channel.

### Spaces

- **One memorable link per team.** `/s/platform-team`, and that's the URL you
  paste in chat.
- **Protected by default.** New spaces get a six-character room code. People
  enter the code, pick a name, get an avatar, and they're in. Any member can
  mint a new code, or open the space so the link alone is the invite.
- **Roster with presence:** who's around, who's in a session, and a jump
  straight to the table they're sitting at.
- **Session history**, searchable and filterable by kind or date.

### Everything else

- **No accounts, or your accounts.** A name and a cookie by default; point
  `AUTH_MODE=oidc` at any OpenID Connect provider and people sign in with the
  identity they already have.
- **Live for everyone.** WebSocket-backed, with a reconnect banner that tells the
  truth about the connection instead of silently going stale.
- **CSV export** for any session: estimates, votes per person, standup entries.
  Cells that start with `=` are escaped, so an export can't run formulas in a
  spreadsheet.
- **Facilitator handover.** Hand off explicitly, or if the facilitator drops off,
  anyone at the table can take over after a 60-second grace period.
- **Light, dark, and system themes.**
- **Boring to operate.** `/healthz` that never touches the database, `/readyz`
  that does, structured JSON logs, migrations applied at boot, and a refusal to
  start rather than run against a database a newer version has already migrated.

## More screenshots

| | |
|---|---|
| ![Standup in progress](docs/screenshot-standup.png) | ![The space page](docs/screenshot-space.png) |
| A standup mid-rotation, timer running | Sessions, roster, and the room code |

![The same round in dark mode](docs/screenshot-poker-dark.png)

## Quickstart

### On your own machine

Two files, no checkout. Tagged releases publish a multi-arch image (amd64 and
arm64) to `ghcr.io/jacorbello/parley`, and the compose file pulls it.

```sh
mkdir parley && cd parley
base=https://raw.githubusercontent.com/jacorbello/parley/main
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

### Against a Postgres you already run

Skip compose entirely and point the image at your own database:

```sh
docker run -d --name parley -p 8080:8080 \
  -e DATABASE_URL='postgres://parley:secret@db:5432/parley' \
  -e BASE_URL='https://parley.example.com' \
  ghcr.io/jacorbello/parley:latest
```

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `BASE_URL` | no | `http://localhost:8080` | The address users reach Parley at. Drives cookie `Secure` and the WebSocket origin check. |
| `PORT` | no | `8080` | Listen port |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |
| `TRUST_PROXY_HEADERS` | no | `false` | Read the client address from `X-Forwarded-For`. Required behind a proxy, unsafe without one — see below |
| `AUTH_MODE` | no | `open` | `open` for no accounts, `oidc` to sign in through an identity provider |
| `OIDC_ISSUER` | with `oidc` | — | Issuer base URL, the one serving `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` | with `oidc` | — | Client ID registered with the provider |
| `OIDC_CLIENT_SECRET` | with `oidc` | — | Client secret |
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
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

Set `BASE_URL=https://parley.example.com` to match, and set
`TRUST_PROXY_HEADERS=true` so the room-code throttle counts real clients rather
than seeing every request as coming from the proxy.

Get this one the right way round, because it is wrong in both directions:

- **Directly reachable, set to `true`** — `X-Forwarded-For` is written by
  whoever sends the request, so a script hands itself a fresh address per guess
  and walks straight through the room-code throttle.
- **Behind a proxy, left `false`** — every visitor arrives wearing the proxy's
  address, so the throttle counts them all as one client and eight wrong
  guesses lock the whole internet out of that space for a minute.

`deploy/k8s/deployment.yaml` sets it to `true` because an Ingress always
terminates the connection. `docker-compose.yml` leaves it `false` because it
publishes the port straight to clients.

## Kubernetes

`deploy/k8s/deployment.yaml` (in this repo — clone it, or fetch that one file)
is a starting point. Two things in it are
load-bearing rather than stylistic. `replicas: 1` + `strategy: Recreate`: the
realtime hub is in-process, and a second replica refuses to start via a Postgres
advisory lock. And the liveness probe hits `/healthz`, which never touches the
database, because a DB blip must not restart the pod and drop every WebSocket.

Parley ships no Postgres for Kubernetes. Bring a managed database or an
operator, then give the Deployment its connection string and pin an image tag:

```sh
kubectl create secret generic parley \
  --from-literal=database-url='postgres://parley:secret@host:5432/parley'
kubectl apply -f deploy/k8s/deployment.yaml
```

A deploy or a node drain is a few seconds of downtime — one replica, `Recreate`,
and the client's reconnect banner covering the gap. If a new pod logs
`advisory lock ... already held`, the old one hasn't exited yet; it will start on
the next retry. There is deliberately **no PodDisruptionBudget**: the only one
that would protect a single replica (`maxUnavailable: 0`) deadlocks the drain it
was meant to survive.

## Sign-in

Parley runs in one of two modes, set by `AUTH_MODE` and fixed at boot.

**`open`** is the default and the original: no accounts at all. People type a
name, get an avatar, and take a seat. Nothing to administer, nothing to
provision, and a stranger with the link and the room code is a participant.

**`oidc`** hands sign-in to your identity provider. There is no vendor-specific
code in Parley — it is a plain OpenID Connect relying party that reads the
issuer's discovery document, so anything speaking OIDC works and switching
providers is a change of configuration:

```sh
AUTH_MODE=oidc
OIDC_ISSUER=https://keycloak.example.com/realms/yourteam
OIDC_CLIENT_ID=parley
OIDC_CLIENT_SECRET=...
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
  people behind them come back as new federated accounts. Plan the switch for
  an instance whose history you're willing to leave behind, or wait for account
  linking.

Names come from the provider's claims — `name`, then `preferred_username`, then
the local part of `email` — and refresh on every sign-in, so a rename upstream
follows the person onto the roster. Signing out ends the Parley session only; it
does not sign anyone out of the identity provider.

## Security model

In `open` mode Parley has **no user accounts**. A space is guarded by a shared
room code, not by identity: anyone holding the code can join, and joining grants
full participation — seeing the roster, voting, and writing standup entries.
Joins are broadcast to the room, so lurking is visible. Run Parley on your
internal network, behind an identity provider (see above), or behind an SSO
proxy (oauth2-proxy, Authelia, Cloudflare Access; the reverse proxy snippet
above is where it slots in).

Room codes work the same either way. Identity says who you are; the code says
which room you may enter. Signing in does not by itself get anyone into a
space — per-user and per-team access to a space is still on the roadmap.

Room codes are six characters from a 25-character alphabet, and wrong guesses
are throttled per client address. They are stored **readable** in the database
on purpose: a room code is meant to be read off the space page by any member
and passed on, the way a Meet or Zoom code is, so hashing it would only mean
nobody could ever see it again. Treat a database dump as disclosing the room
codes of every space — but not any member's identity. Session cookies remain
opaque random tokens stored hashed, so a backup still contains no credentials
that impersonate a person. Any member can mint a new code (retiring the old
one) or open the space entirely.

What Parley does enforce: acting in a space requires having joined it; a
protected space refuses joins without the code; session existence is never
disclosed to non-members; facilitator-only actions (reveal, reset, closing a
session) are server-checked.

Found something? Open a
[security advisory](https://github.com/jacorbello/parley/security/advisories/new)
rather than a public issue.

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

**Parley:** bump the tag in `docker-compose.yml`, then `docker compose pull &&
docker compose up -d`. Migrations run
automatically at boot. Rolling *back* an image is only safe if the newer
version didn't add migrations — if it did, Parley refuses to start with a
message telling you so; restore from backup instead.

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
- **`/readyz` fails but `/healthz` is fine.** The app is up, Postgres isn't.
  Check the `db` container and `DATABASE_URL`.
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
| `cmd/parley` | main — config, boot, single-replica lock |
| `internal/api` | HTTP router, identity, spaces, sessions, room codes |
| `internal/poker`, `internal/standup` | the session kinds |
| `internal/session` | the registry the kinds plug into, plus CSV |
| `internal/hub` | WebSocket fan-out and presence |
| `internal/store` | Postgres queries |
| `internal/db/migrations` | numbered SQL, applied at boot |
| `web` | Vite + React frontend, embedded into the binary |

Session kinds are self-contained packages registered in `internal/session`, so
adding a new kind means one new package and one `Register` call.

## Roadmap

Nothing here is promised, and the order will change.

- Knock-to-join: request access from the door, let the facilitator wave you in.
- Linking an existing anonymous account to a federated one, so an instance can
  turn sign-in on without leaving its history behind.
- Per-user and per-team access to a space, so a rotated room code isn't the only
  lever. The room code is deliberately a first step, not the destination.

## Contributing

Issues and pull requests are welcome. A few things that make review quick:

- Open an issue before a large change, so nobody builds the wrong thing twice.
- `go test -p 1 ./...` and `npm run lint` pass.
- A behaviour change comes with a test that fails without it.
- Migrations are additive and numbered; never edit one that has shipped.

## License

[MIT](LICENSE)
