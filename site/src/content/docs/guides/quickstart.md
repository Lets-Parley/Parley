---
title: Quickstart
description: Get Parley running on your machine, then on a server your team can reach.
---

## On your own machine

```sh
git clone https://github.com/jacorbello/parley && cd parley
cp .env.example .env        # set POSTGRES_PASSWORD to anything
docker compose up -d
```

Open http://localhost:8080 — you should see the Parley landing page. Name a
space, share nothing yet: it's bound to localhost.

## On a server, shared with your team

Two changes, made together:

1. In `docker-compose.yml`, change the port binding from `127.0.0.1:8080:8080`
   to `0.0.0.0:8080:8080` — or better, leave it and put a
   [reverse proxy](/guides/reverse-proxy/) in front.
2. In `.env`, set `BASE_URL` to the address your teammates will use, e.g.
   `BASE_URL=http://192.168.1.10:8080` or `https://parley.example.com`.

`BASE_URL` drives the WebSocket origin check and the session cookie's Secure
flag. If it doesn't match how people actually reach the server, boards sit at
"reconnecting" or logins won't stick. See [Troubleshooting](/guides/troubleshooting/).

## From a prebuilt image

Tagged releases publish a multi-arch image (amd64 and arm64) to
`ghcr.io/jacorbello/parley`. Bring your own Postgres:

```sh
docker run -d --name parley -p 8080:8080 \
  -e DATABASE_URL='postgres://parley:secret@db:5432/parley' \
  -e BASE_URL='https://parley.example.com' \
  ghcr.io/jacorbello/parley:latest
```

## What you get

A space at `/s/your-team` with a six-character room code. Anyone with the link
and the code picks a name, gets an avatar, and is in. Start a poker session or a
standup from there.
