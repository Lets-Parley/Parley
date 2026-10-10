# Local CSV proof

Status: executed renderer proof; no live HTTP/database or remote provider proof.
Date: October 10, 2026. Source commit:
`098c6607bc170b7a904f479db974c37f522ca53a`.

The maintainer selected CSV export instead of remote live proof for #796.
[Input program](fixtures/csv-proof.go.txt) uses `poker.Kind().CSV` on a synthetic,
already client-safe envelope and `encoding/csv.Writer`, the same renderer and
writer used by `internal/api/export.go`. It asserts five cases before writing
the [actual output](fixtures/csv-proof.csv): preserved `½`, blank estimate,
ordinal `M`, explicit `0`, and escaped formula-like title. The synthetic rows
represent independent candidates and parent history; they do not create a
split, establish a parent relation, or exercise authorization/redaction.

Reproduce from the repository root with the project's Go/Node toolchains and
installed frontend dependencies:

```sh
npm run build --prefix web
mkdir -p .csv-proof
cp docs/integrations/fixtures/csv-proof.go.txt .csv-proof/main.go
go run ./.csv-proof > /tmp/parley-csv-proof.csv
cmp docs/integrations/fixtures/csv-proof.csv /tmp/parley-csv-proof.csv
rm .csv-proof/main.go
rmdir .csv-proof
```

A fresh clone requires `npm ci --prefix web` before the build. Use a writable
`GOCACHE` if required by the environment. The build ran before the Go proof.
`TEST_DATABASE_URL` was unset; no database opt-out was used. No database-backed
test, HTTP export, browser/spreadsheet view, remote API, native parent/dependency,
Project field/default or counting behavior is verified by this result.

The output SHA-256 is
`5920125735fc68db9f76f32d9222258d1921279ecc874a45c9fc32a2733550fa`.

The renderer preserves labels rather than converting them to provider values.
A person can review blank versus explicit zero and retain a parent's earlier
estimate. The CSV does not implement numeric/ordinal provider mapping and does
not sum, clear, publish or automatically import anything. Formula escaping is
an existing behavior, confirmed on the sample; the proof makes no wider
spreadsheet compatibility claim.

For end-to-end local proof later, use a dedicated Parley test database, create
a room through its normal API/UI, export as an authorized member via
`GET /api/sessions/{id}/export.csv`, and compare the rows with visible state.
Exercise an outsider and unrevealed votes with the existing API tests. Record
the tested split-model commit separately when that model is available; this
fixture does not verify child identity, relation or split-history retention.

The [capability contract](split-publication-contract.md) keeps the remote
publication gate open until a destination is authorized and its manual checks
are completed. No meeting data or test issues were written to GitHub.
