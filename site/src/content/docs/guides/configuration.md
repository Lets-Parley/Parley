---
title: Configuration
description: Every environment variable Parley reads, what it does, and what breaks if it is wrong.
---

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `BASE_URL` | no | `http://localhost:8080` | The address users reach Parley at. Drives cookie `Secure` and the WebSocket origin check. |
| `PORT` | no | `8080` | Listen port |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |
| `TRUST_PROXY_HEADERS` | no | `false` | Read the client address from `X-Forwarded-For`. Required behind a proxy, unsafe without one. |
| `AUTH_MODE` | no | `open` | `open` for no accounts, `oidc` to sign in through an identity provider |
| `OIDC_ISSUER` | with `oidc` | — | Issuer base URL, the one serving `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` | with `oidc` | — | Client ID registered with the provider |
| `OIDC_CLIENT_SECRET` | with `oidc` | — | Client secret |
| `OIDC_SCOPES` | no | `profile email` | Extra scopes; `openid` is always requested |

Boot logs print the derived settings (`cookie_secure`, `allowed_ws_origin`,
`auth_mode`, `trust_proxy_headers`), so a misconfiguration is visible in the
first three lines.

## TRUST_PROXY_HEADERS

Get this one the right way round, because it is wrong in both directions.

**Directly reachable, set to `true`** — `X-Forwarded-For` is written by whoever
sends the request, so a script hands itself a fresh address per guess and walks
straight through the room-code throttle.

**Behind a proxy, left `false`** — every visitor arrives wearing the proxy's
address, so the throttle counts them all as one client, and eight wrong guesses
lock the whole internet out of that space for a minute.

`deploy/k8s/deployment.yaml` sets it to `true` because an Ingress always
terminates the connection. `docker-compose.yml` leaves it `false` because it
publishes the port straight to clients.
