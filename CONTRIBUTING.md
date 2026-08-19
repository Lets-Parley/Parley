# Contributing

Bug reports, questions and pull requests are all welcome.

## Before you start on something large

Open an issue first. The [roadmap](ROADMAP.md) has the direction, and a
substantial change is much easier to accept when the shape of it was agreed
before it was written.

## Development

You need Go (the version in `go.mod`), Node 24, and a Postgres you can throw
away.

```sh
# frontend
cd web && npm ci && npm run dev
cd web && npm test              # Vitest; npm run test:watch while working

# backend
export DATABASE_URL=postgres://parley:dev@localhost:5432/parley
go run ./cmd/parley
```

Full setup, including the layout of the repository, is at
<https://www.letsparley.io/project/contributing/>.

## Tests

```sh
export TEST_DATABASE_URL=postgres://test:test@localhost:5432/test
go test -p 1 -race ./...
```

`-p 1` is load-bearing: packages share one test database and will collide if
they migrate it concurrently.

## What a good pull request looks like

- **One thing.** A focused diff gets reviewed; a mixed one waits.
- **A test that has been seen to fail.** If it is a bug fix, reintroduce the bug
  and watch the test fail before you keep it. A regression test that has never
  failed is decoration.
- **Migrations are forward-only and additive.** They are numbered, embedded, and
  run one per transaction. Never edit a migration that has shipped. The
  filename prefix is the version, so it must be purely numeric
  (`0010_thing.sql`); a name like `0010a_thing.sql` is rejected at startup.
- **Documentation changes with the behaviour.** If you change a limit, a default
  or a security property, update `site/` in the same pull request. The
  documentation states what the code does, and pages carry the version they were
  verified against.
- **Do not overclaim.** If something is half-built, say so in the docs rather
  than describing the intended version.

## Style

Match the surrounding code. `go vet` must pass, `gofmt` is assumed, and the
frontend has `oxlint` configured.

Commit messages are lowercase, imperative, and say what changed and why.

## Reporting a vulnerability

Not here — see [SECURITY.md](SECURITY.md).
