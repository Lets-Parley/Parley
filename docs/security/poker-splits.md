# Poker split boundary evidence

The split foundation extends facilitator-owned local Poker stories. It adds no
provider, token, egress, plugin capability, or organization-wide reading access.
Session routes remain unprefixed, and child/parent queries include their session.
An additive composite foreign key also binds parent identity to the same room.

The action dispatcher checks the facilitator and active room. Split mutations
repeat those checks under the existing session row lock and recheck space and
unrevoked org membership, excluding link identities. Child content edits use the
same membership check. Registered action verbs are independently classified for
link guests. Embedded facilitators retain existing Poker authority; embedded
participants remain read/vote participants.

`internal/api/poker_split_test.go` covers operation replay and mismatched reuse,
concurrent creation, quota/cap refusals, stale individual edits, independent child
edits, adoption snapshot/coverage/minimum checks, retained removal/Undo, unauthorized
and foreign-session requests, and facilitator/membership/ended state changed while
a mutation waits on the lock. The HTTP CSV check verifies parent 13 remains context,
child 3/5/blank remains independent, and stable ids/roles survive export.
`internal/db/poker_splits_test.go` upgrades a pre-split ended room with notes/ref,
estimate and vote intact. Existing redaction, signed-link and embedded suites
remain required alongside these checks.

The new action tests were observed failing with `no such action` before the
implementation. The CSV test failed against the six-column split export, and the
frontend queue test failed with four counted rows before planning-role filtering.
Local verification uses a disposable Postgres 16 database with
`TEST_DATABASE_URL` set and no database opt-out. Full command results are recorded
in the pull request; this scoped evidence does not establish complete ASVS coverage.

The tree editor's typed-input/focus/authority-loss browser flows, dependency graph
editor, grouped continuation and publication receipts remain separate work.
Removal retains rows for future receipts; no remote deletion is available here.
Operators still own backup/restore and restored-revocation reconciliation. The
existing database archive lifecycle retains these additive columns without a
custom import format or a new restore path.

Sibling dependencies use the same session lock and membership recheck, with a
separate parent relationship revision and exact parent/retained-child content
snapshot. Graph validation rejects unavailable, foreign-parent, foreign-session,
self/duplicate pairs and cycles before writing. The canonical local edge id survives
rename and retirement. Removal enumerates affected ids; Undo revalidates and keeps
unsafe intent explicitly review-needed. Dependency writes cannot change round,
selection, hierarchy, order, accepted points, or hidden votes.

`internal/api/poker_dependencies_test.go` exercises opposing concurrent saves,
longer named cycles, duplicate-title identities, stale graph/content snapshots,
wrong-parent endpoints, read-only participants, loss of facilitator/space/org
membership and ended rooms while waiting on the lock, retained removed blockers,
safe/unsafe Undo, retirement and hidden-vote/round preservation. The new route
was first observed failing 404, and removal without link acknowledgment first
failed by incorrectly succeeding. `scripts/guard-mutation.sh` mutates graph,
revision, acknowledgment and Undo guards. These scoped local checks add no live
provider capability evidence: remote deleted/inaccessible endpoints, publication
receipts and authorization are not implemented here and must not be inferred.
