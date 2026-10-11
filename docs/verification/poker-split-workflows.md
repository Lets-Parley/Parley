# Poker split workflow verification

Recorded October 10, 2026 for #795. The composed workflow source was tested at
`c90e429b21166054e736b4d8ffb30891eb76b67f`, including the committed #793 dependency
editor and fixed-tray focus prerequisite. This is bounded maintainer evidence, not a completed product
usability gate, live tracker proof, or assurance assessment.

## Composed checks

An isolated Chromium session used a real Parley server, open authentication,
Postgres 16, the Fibonacci deck, and synthetic data. No AI, tracker, plugin,
provider credentials or production data were configured. Three separate tickets
exercised title-only entry, optional refinement, and API + Permissions blocking
UI. Each retained historical parent 13, independent child 3 and 5, and blank UI.
The local verifier used Playwright already available in the development
environment; no browser framework or dependency was added to Parley.

| Scenario | Observed result | Boundary and remaining limits |
| --- | --- | --- |
| Three children entered with Enter; optional notes saved explicitly | Three stable child identities; adoption acknowledged immediately | Blank/IME and repeat activation remain automated component regressions; this run did not use a real IME |
| Creation committed, HTTP response aborted | Saved child reconciled to one identity through current shared state or explicit recovery; no second child | Component tests separately cover the stable operation retry; no offline write queue is implied |
| Full-coverage adoption and independent direct estimates | Parent becomes context; child values remain 3, 5, Unestimated | No rollup, completion, or consensus inferred |
| Two Blocked by selections saved for UI | API and Permissions block UI; dependency-only editing leaves values and active story unchanged | This is local intent; remote native links and execution readiness are unchecked |
| Two tabs edit the same graph | Latest/mine review retains unsent choices and disables stale Save; Cancel leaves the other tab's save intact | API graph tests separately reject concurrent cycles atomically |
| Child Deal and presenter | UI on the table; presenter names parent and both independent accepted sibling values | Meet payload/component tests passed; this was not a live Google Meet embed |
| End and reopen | Grouped parent context and children retained, normal Reopen works | API continuation tests compare retained state and authorized CSV exactly |
| Both themes, 320 CSS px, normal/doubled root text sizing | Document width stayed 320; visible tree controls and checkbox labels measured at least 44px in both dimensions | Doubled text sizing is **not actual browser zoom**, a mobile software keyboard, or safe-area device testing |
| Keyboard focus in dependency editor; Escape | Focused full labels stayed above the fixed tray; Escape restored its contextual trigger; 2px solid focus outline | No screen-reader speech, quiet-announcement listening or full keyboard-only journey was observed |
| Solid-surface contrast samples | Visible enabled tree text samples at least 4.5:1; checkbox accent and focus outline 8.20:1 light / 6.24:1 dark | Computed solid ancestor colors; not an exhaustive screenshot audit of every control, state or surface |
| Reduced motion | Same actions completed; no tree animations | Connector motion is omitted; no animation delay or replay is needed |

Verifier preparation corrected contextual locator mismatches and waited for
focus state updates. The #793 browser run separately found focus obscured by the
fixed voting tray; its implementation and red-first evidence belong to that
prerequisite. Final composed checks include the full label boundary against the measured
fixed tray, in addition to viewport bounds. Each text-sizing variant uses a
genuine keyboard focus transition; changing root text size while leaving focus
on the same control is not a verified browser-zoom interaction. This issue adds composed
acceptance and documentation, and does not duplicate the meaningful red-first
regressions recorded for #789–#794.

## Automated verification

`TEST_DATABASE_URL` was set for every Go test; `PARLEY_SKIP_DB_TESTS` was not used.
The Go commands tested the same backend sources before the frontend-only tray
fix; final frontend/browser checks used the revision above. The focused
continuation baseline passed against the dedicated database on local
port 55442. The full race suite used a separate dedicated database on port 55443:
the local extracted PostgreSQL fixture there uses the CI-equivalent timezone
catalog (`localtime` absent, `Etc/GMT+1` present). This corrects the local fixture;
no source guard or test was weakened. Frontend build preceded Go compilation.

- `npm ci && npm run build` in `web`: passed.
- `go vet ./...`: passed.
- `go test -p 1 ./internal/api -run 'TestSplitContinuationCloseReopenExport|TestLeaveUnestimatedKeepsScopeAndVotes' -count=1`: passed with database set.
- `go test -p 1 -race ./...`: passed with database set, including the full API suite (432.9 seconds).
- `npm run lint` in `web`: passed.
- `npx vitest run` in `web`: passed, 64 files / 1,499 tests, including axe and Meet/projection regressions. Local Node 24 does not support the repository `npm test` wrapper's `NODE_OPTIONS=--no-webstorage`; CI remains the wrapper gate.
- `npm ci && npm run build` in `site`: passed, including skip-link postbuild checks.

Local raw logs, synthetic screenshots and the one-off verifiers were retained in
`/tmp/issue-795/` during the run. The commands, source revision, scenario steps and
limits here are the durable evidence; those local files are not published assets.

## Archive and rollout

`pg_dump -Fc` archived the synthetic workflow database. `pg_restore --no-owner
--no-privileges --exit-on-error` restored it into a uniquely named disposable
database. Sorted JSON projections of `stories`, `poker_dependencies`, `sessions`
and `votes` matched before and after restore, SHA-256
`5132c7384d8be2a0093f7da40fd677b405c1847ada9990b9c694e30046759954`.
The restore database was dropped. This proves that fixture's retained identities,
local graph, values and room state survive the archive; it does not prove operator
RPO/RTO, key recovery, or restored authorization reconciliation.

The [upgrade guide](../../site/src/content/docs/operations/upgrading.mdx) requires
all replicas and loaded clients to upgrade before split use. Additive migrations
preserve flat historical rooms but cannot make older writers obey new guards.
There is no rollout flag. Initially restrict use operationally to a few rooms;
pause writes on failure. Returning to an older binary requires its matching
pre-upgrade backup, loses later writes, and requires the documented revocation,
deletion and queue reconciliation before access or egress resumes.

Removed children remain retained and count toward the cap of 10; adoption and
retention require two active children. Normal session/database retention and
backup rules apply, with no separate archive/import format. Facilitators edit;
participants and signed-link guests retain only their authorized read/vote access.
Local intent, provider receipt confirmation and completion remain separate facts.
The host receipt service in this baseline is fake-provider tested; provider
capability and outbound production delivery are separate gates.

## Unresolved product gates

#795 remains open for real screen-reader speech and announcement checks, a full
keyboard-only room journey, actual 200% browser zoom, real mobile software
keyboard/safe-area/fixed-hand layouts, comprehensive control/focus contrast,
live Meet embedding, and unfamiliar observers. Ask observers to explain planning
counts, blocker direction, unchecked completion and remote truth without coaching;
record mistakes, help and voluntary reuse rather than speed/adoption claims. No
observer session or demand inference is recorded here. Optional live provider
proof belongs to #798 and cannot close these core usability gates.
