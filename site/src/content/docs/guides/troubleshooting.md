---
title: Troubleshooting
description: The failures people actually hit, and what each one means.
---

### `docker compose up` fails with `set POSTGRES_PASSWORD in .env`

Copy `.env.example` to `.env` and set a password. This is required on purpose;
there is no default database password.

### A permanent "reconnecting" banner

The WebSocket origin check is rejecting your browser. Set `BASE_URL` to the
exact address in your address bar — scheme, host and port — and restart. Behind
nginx, confirm the Upgrade and Connection headers from the
[reverse proxy](/guides/reverse-proxy/) config.

### You set a name, but every refresh forgets you

`BASE_URL` is `https` while you're browsing over plain `http`, so the browser
drops the Secure cookie. Serve over HTTPS, or set an `http` `BASE_URL`.

### `/readyz` fails but `/healthz` is fine

The app is up, Postgres isn't. Check the database container and `DATABASE_URL`.
This split is deliberate: liveness never touches the database, so a blip can't
restart the process and drop every open session.

### "That passcode doesn't match this space"

Codes are six characters and case-insensitive; spaces and hyphens are ignored.
After eight wrong tries from one address, wait a minute.

### Everyone gets locked out of a space after a few wrong guesses

The throttle is counting your whole team as one client because
`TRUST_PROXY_HEADERS` is `false` behind a proxy. See
[Configuration](/guides/configuration/).

### Nobody can start the standup

The rotation is built from whoever has the session open. Everyone joins first,
then the facilitator starts.

### A pod logs `advisory lock ... already held`

The previous instance hasn't exited yet. Parley is single-replica by design and
takes a Postgres advisory lock to enforce it. It starts on the next retry. See
[Kubernetes](/guides/kubernetes/).
