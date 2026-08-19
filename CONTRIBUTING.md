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

Database-backed tests **fail** when `TEST_DATABASE_URL` is unset — most of the
suite needs Postgres, and a green run that quietly tested nothing is worse than
a red one. If you genuinely have no database to hand, set
`PARLEY_SKIP_DB_TESTS=1`; the run then skips those tests and prints a warning
naming every package it silenced. CI asserts the variable is unset and fails on
any skipped test, so the opt-out cannot creep back in.

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
