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

Child-round acceptance adds scope and accepted-round versions without expanding
reading authority. Before reveal, vote values remain absent from the projection.
The current split-related story identity and round version are checked inside the
session lock for votes, Reveal and Reset. A child with prior votes requires
reviewed fresh-round selection; adoption away from a live or unsaved-revealed
parent requires explicit review. Scope changes preserve prior estimates as Needs
review and restart only the affected active round. A Poker acceptance requires a
revealed nonempty round and current story/content/scope/round; direct acceptance
is separately labeled Facilitator-set and validated against the copied deck.
No hidden votes are added to acceptance metadata or to future publication data.

`internal/api/poker_child_rounds_test.go` covers canceled and stale switches,
reselect clearing, delayed votes/control requests, old scope and save revisions,
empty-round refusal, direct/Poker provenance, special/off-deck rejection,
independent siblings, historical Needs review and deliberate reaffirmation,
summary exclusion and CSV labels. Existing split/guest/embedded authority tests
remain gates; dependency preservation now also compares scope/provenance fields.
The new cases were observed failing before their guards were implemented.
The added `guard-mutation.sh` entries break identity/round, parent switch,
fresh-round confirmation, scope restart and empty-round acceptance guards.

Local commands use `TEST_DATABASE_URL` set with no database opt-out. The full
race suite has one known environment-dependent baseline limitation: the local
extracted PostgreSQL installation exposes the `localtime` zone and fails
`TestZoneReadableAsksPostgres`, reproduced on unchanged main during #790.
Exact command outcomes are recorded in the PR. Browser checks of both themes,
320px/200% zoom, screen-reader operation and contrast are not established by
jsdom; they remain explicit manual verification before broad rollout. All
serving writers must support split-round guards before operators use splits.
No provider capability, delivery/approval service or completed ASVS assessment
is claimed by these scoped checks.
