# Parley frontend

Vite + React + TypeScript. `npm run build` writes `dist/`, which `go:embed`
compiles into the Parley binary — there is no second service in production, and
a stale `dist/` means the binary serves a stale UI.

```sh
npm install
npm run build     # required before `go build` / `go test ./...`
npm run dev       # Vite dev server, proxies /api and /ws to :8080
npm test          # Vitest
npm run lint      # Oxlint
```

`npm run dev` needs the Go server running on `:8080` for anything past the
landing page.

## Layout

| Path | What lives there |
|---|---|
| `src/pages` | one file per route — `PokerRoom`, `StandupRoom`, `SpacePage` |
| `src/components` | shared UI: `AppShell`, `MemberCard`, timers |
| `src/lib` | API client, WebSocket wiring, derived state (`derive.ts`), `kinds.ts` |

Adding a session kind touches `src/lib/kinds.ts` and adds a page; the Go side
and the migration are covered in
[Adding a session kind](https://www.letsparley.io/project/contributing/#adding-a-session-kind).
