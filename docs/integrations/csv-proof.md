# Local CSV proof

Status: executed renderer and local HTTP/database proofs; no remote provider proof.
Date: October 10, 2026. Baseline renderer source commit:
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

## Split HTTP export proof

The [HTTP input procedure](fixtures/split-csv-proof.py) ran against a binary
built from [PR #800](https://github.com/Lets-Parley/Parley/pull/800) head
`f919a45d00abd7cdfdeb709e062c20712b4b5bf2` in a clean source worktree.
That head was **unmerged at proof time**; this evidence depends on PR #800's
split-model implementation and does not claim it was already shipped.
The binary SHA-256 was
`7cd8596daf6b7ffd0073fecfd6d296916e5116bf60b843e231836e12af036fa3`.

An isolated Postgres 16.15 database, `parley_test_796`, served only this proof
on localhost port 55439. The Parley instance bound localhost port 58096 in
open mode. `DATABASE_ALLOW_PLAINTEXT=true` was explicitly selected for that
trusted local-only connection. `DATABASE_URL` was set; `TEST_DATABASE_URL`
was unset, no database-test opt-out was used, and no Go test suite is claimed.
No production database, external destination, provider token or user content
was involved.

The procedure created three synthetic identities, one space and a poker room
through HTTP, added a parent with estimate `13`, drafted three children,
saved independent `3` and `5` estimates, left the third blank, and adopted the
complete split using current revisions. An ordinary joined member exported
`GET /api/sessions/{id}/export.csv`. The procedure parsed the actual response
and checked parent context/history, child IDs and parent references,
planning roles, estimates and content revisions against the member's visible
room state. It checked the CSV content type/attachment header and an outsider's
`404` response. All assertions passed.

The [actual split CSV response](fixtures/split-http-proof.csv) SHA-256 is
`2c8c1480dec0929cf5c9b74a6bdc60631ee75751dbf95affd937ac7c8f36b11c`.
Its UUIDs identify only synthetic disposable local records. The parent stays
`13`; children stay `3`, `5`, and blank. No arithmetic or remote clearing
occurred. Split rows include local identity, relation, role and revision
columns; these are not native provider IDs or provider relationship proof.

To reproduce, build PR #800's exact head after building its frontend, boot its
binary with a fresh isolated database and the local settings above, then run
from the documentation checkout:

```sh
python3 docs/integrations/fixtures/split-csv-proof.py \
  http://127.0.0.1:58096 /tmp/parley-split-http-proof.csv
```

The command refuses other hosts/ports. Use a fresh database for each run;
it intentionally performs local setup writes. UUIDs vary, so its structural
assertions, rather than byte comparison with the recorded UUIDs, are the
reproduction check. Stop the proof instance and drop only its disposable
database after the run. The executed instance and database were cleaned up.

Browser/spreadsheet rendering, vote redaction under an active unrevealed
round, removal/restoration, upstream API/UI compatibility, native parentage,
dependencies, Project fields/defaults and counting remain outside this proof.
Existing API tests cover additional local behavior; they are not evidence
of an executed suite in this record.

The [capability contract](split-publication-contract.md) keeps the remote
publication gate open until a destination is authorized and its manual checks
are completed. No meeting data or test issues were written to GitHub.
