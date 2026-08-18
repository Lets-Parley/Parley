---
title: Development
description: Building Parley, running its tests, and where things live.
---

```sh
cd web && npm install && npm run build && cd ..   # embedded assets
go test -p 1 ./...                                # unit tests
TEST_DATABASE_URL=postgres://... go test -p 1 ./...  # + integration tests
cd web && npm run dev                             # Vite dev server, proxies /api and /ws to :8080
```

`-p 1` matters: the integration tests share one database and migrate it, so
running packages in parallel makes them fight over the schema.

## Layout

| Path | What lives there |
|---|---|
| `cmd/parley` | main — config, boot, single-replica lock |
| `internal/api` | HTTP router, identity, spaces, sessions, room codes |
| `internal/auth` | OpenID Connect relying party |
| `internal/poker`, `internal/standup` | the session kinds |
| `internal/session` | the registry the kinds plug into, plus CSV |
| `internal/hub` | WebSocket fan-out and presence |
| `internal/store` | Postgres queries |
| `internal/db/migrations` | numbered SQL, applied at boot |
| `web` | Vite + React frontend, embedded into the binary |
| `site` | this documentation site |

Session kinds are self-contained packages registered in `internal/session`, so
adding a new kind means one new package and one `Register` call.

## Contributing

Issues and pull requests are welcome. A few things that make review quick:

- Open an issue before a large change, so nobody builds the wrong thing twice.
- `go test -p 1 ./...` and `npm run lint` pass.
- A behaviour change comes with a test that fails without it.
- Migrations are additive and numbered; never edit one that has shipped.
