# plugins/

Ceremonies that extend Parley without a core commit. A pull request that
touches this tree may not also change `internal/`, `cmd/`, `web/src/`,
`web/embed.go`, `go.mod` or `go.sum` — `scripts/check-core-untouched.sh` is
the CI leg.

| Directory | Ceremony |
| --- | --- |
| `retrospective/` | Columns, cards, reveal, grouping, dot voting, action items |
