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

## October 11 keyboard, native zoom and focus follow-up

The follow-up tested main `5840eac368bcb5cc514de086b0eec15a8443c48b`
with the refinement focus fix. The tested `StoryTree.tsx` Git blob is
`7f29d881927838151dd9d9fdde3760111b83aa1a`. A headed Chromium session used
the real server and isolated Postgres database on port 55443. Authentication,
space and room creation used synthetic API fixtures; subsequent room actions
used only native Tab, typing, Enter, Space and Escape events.

The complete journey recorded 60 target transitions and 591 Tab presses:
create/deal/estimate parent 13; enter API, Permissions and UI; refine notes and
cancel/save; adopt full coverage; independently set API 3 and Permissions 5;
save API + Permissions blocking UI; cancel the dependency editor; remove/Undo
Permissions; deal/vote/reveal/accept API 3; deal siblings and start a fresh round;
leave UI unestimated; end and reopen. Escape restored the contextual triggers.
This is keyboard operation evidence, not screen-reader speech or observer evidence.

An unpacked, temporary browser extension called native `chrome.tabs.setZoom(2)`
and confirmed `getZoom() === 2` with automatic per-origin zoom. A 640px browser
window changed from 640 to 320 CSS px; device-pixel ratio changed from 1 to 2.
Root font remained 16px and visual-viewport scale remained 1. This is actual
browser zoom, unlike the earlier doubled-root-text check. Both themes retained
document width within the viewport, tree targets at least 44px in both dimensions,
and no tree animation with reduced motion.

The expanded check found refinement Notes behind the fixed voting hand.
Before the fix, browser textarea bottoms were 611px light and 359px dark against
tray top 286px. The new component regression failed on the obscured label boundary
before implementation. The existing measured-tray focus handler now belongs to
the whole story tree. After the fix, focused Notes labels were top 139px / bottom
270px, and focused dependency labels bottom 269.93px, against tray top 286px in
both themes. Native typing and two-character keyboard selection remained focused;
the component regression also retained multiline input. Escape canceled without
saving. Foreground CDP surface screenshots
confirmed the focused Notes field and selection above the actual tray. Cropped
Playwright screenshots under native zoom were discarded as rendered evidence.

Enabled tree text samples in refinement/dependency states measured at least
6.69:1 light and 7.15:1 dark. Unfocused form boundaries measured 4.31:1 / 3.73:1;
focused form borders and outlines measured 8.20:1 / 6.24:1. Direct surface pixels
matched the computed title/Notes boundary colors and checked checkbox accent in
both themes. This extends the control/focus evidence but does not audit every
control state, platform or browser.
Within the native checked checkbox bounds, the actual solid fill/check pixels
were RGB 29/78/110 and white in light mode (8.87:1), and RGB 95/168/211 and
59/59/59 in dark mode (4.28:1). Fill against the surrounding surface measured
8.20:1 / 6.24:1. Antialiased edge pixels were not used as solid-color samples.
The narrow follow-up toggled this foreground native control without saving the
graph. Unchecked border/interior pixels were RGB 118/118/118 and white in light
mode (4.54:1), and RGB 133/133/133 and 59/59/59 in dark mode (3.04:1).
The borders against the surrounding surfaces measured 4.20:1 / 4.42:1. Rendered
focused-label outline pixels matched the accent colors in both themes. These
native-paint results apply to this Chromium/platform combination only.

The follow-up ran frontend build before Go compilation, `go vet ./...`, frontend
lint, direct `npx vitest run` (64 files / 1,500 tests), and the site build including
skip-link checks. The local Node wrapper limitation above still applies.
The full `go test -p 1 -race ./...` passed with exit 0 (API package 353.9 seconds);
`TEST_DATABASE_URL` was set to the isolated `parley_test_795_resume` database and
no database opt-out was used. Follow-up logs and private synthetic browser fixtures
remain under `/tmp/issue-795-resume/`; they are not published assets.

## Unresolved product gates

#795 remains open for real screen-reader speech and announcement checks,
real mobile software keyboard/safe-area/fixed-hand layouts, exhaustive control/focus contrast,
live Meet embedding, and unfamiliar observers. Ask observers to explain planning
counts, blocker direction, unchecked completion and remote truth without coaching;
record mistakes, help and voluntary reuse rather than speed/adoption claims. No
observer session or demand inference is recorded here. Optional live provider
proof belongs to #798 and cannot close these core usability gates.

For each remaining human run, record date, source commit, browser/OS, device or
assistive-technology version, exact steps, observed result and remaining failures.

| Human check | Steps and required observation | Recorded result |
| --- | --- | --- |
| Screen reader and quiet announcements | Create/refine/adopt; save/cancel multiple blockers; encounter a remote conflict and authority loss. Listen for names, direction, errors, focus restoration and quiet state changes without duplicate announcements. | Not run; no configured speech/AT environment available |
| Mobile keyboard and safe area | On a real device, type multiline Notes with the keyboard open; tab or navigate between controls; rotate; inspect tray, focused field, Save/Cancel and safe-area insets. | Not run; no real mobile device available |
| Live Meet | Use the authorized meeting embed; deal independent siblings and inspect parent context, hidden/revealed/accepted estimates and reopening. | Not run; no live meeting exercised |
| Unfamiliar observers | Ask for an uncoached split and multi-blocker plan, then explanations of counts, blocker direction, unchecked completion and remote truth. Record mistakes, help and voluntary reuse. | Not run; no observer session conducted |
| Remaining visual states | Inspect enabled/disabled/error/hover controls and native checkbox rendering on the other target browsers in both themes. | Checked/unchecked native paint measured on this Chromium; exhaustive state/platform coverage remains unverified |
