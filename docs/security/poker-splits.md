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

The dependency graph editor, grouped continuation and publication receipts remain separate work.
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
session lock for votes, Reveal and Reset. Selection involving either a split
current or target requires both observed identity and round, even for an unvoted
sibling or a switch back to a flat story. A child with prior votes requires
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
summary exclusion and CSV labels. Selection tests also reject missing, partial
and stale snapshots and serialize simultaneous requests to one successful
switch. Embedded bearer tests reject omitted/stale versions and accept the
observed version for children and parents with drafts; Meet payload tests cover
both. Ordinary Deal/Next payloads and nullable flat Saved status are covered by
frontend tests. Existing split/guest/embedded authority tests
remain gates; dependency preservation now also compares scope/provenance fields.
The new cases were observed failing before their guards were implemented.
The added `guard-mutation.sh` entries break identity/round, parent switch,
fresh-round confirmation, scope restart and empty-round acceptance guards,
mandatory split selection snapshots, and Meet vote metadata.

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


The inline tree uses the existing facilitator action boundary and adds no route
or projection field. `web/src/components/StoryTree.test.tsx` covers stable creation
operations after an unknown response, explicit refinement/adoption, latest/mine
conflict review, refreshed facilitation, removal/Undo and focus. The whole Poker
room is redacted when reconciliation refuses reading authority; a disconnected
room or ended session cannot submit tree writes. Guest and participant views
retain authorized reading and offer no structural mutation. `PokerRoom.test.tsx`
covers full-room revocation and the single-tree/grouped-queue boundary.

The initial component tests were observed failing before implementation. A
removal focus regression failed because the surviving input was still disabled
during acknowledgment; focus now returns after the pending request releases.
A live isolated Chromium run exercised three Enter/touch creates, explicit
adoption, child dealing and Escape/trigger focus. Both themes at 320 CSS px and
200% text zoom are checked for overflow, focus visibility and 44px targets. These
checks do not establish real software-keyboard or screen-reader behavior, or the
unfamiliar-observer rollout criteria in #795. Full command outcomes and browser
limitations are recorded in the pull request. No provider capability or remote
receipt is inferred from a retained ticket key. Connector motion is omitted.


Review regressions cover a remote active-root switch before the first child is
persisted, including unknown-create reconciliation without a second create call.
Parents with a local title or recovery operation stay mounted. An adopted parent
with two planning children and a new proposal reports two planning units and
keeps proposed scope out of Unestimated/Needs review totals; the room/queue test
compares those summaries. Both defects were observed failing before their fixes.

Continuation adds no reading authority or route. Leaving a blank planning item
uses the facilitator-only select action under the active-session lock, checking
current identity/round and retained membership without accepting points or
clearing votes. `internal/api/poker_continuation_test.go` covers stale, mismatched
and omitted snapshots, accepted-item refusal, close/reopen preservation, two
blockers, 13/3/5/blank progress, safe notes and inaccessible exports. Split CSV
uses the existing authorized export envelope; only additive notes and retained
planning dependency identities are serialized. Flat six-column output is unchanged.
`internal/poker/csv_continuation_test.go` covers formula-safe notes, deterministic
edge order, removed blockers, blank values and historical compatibility. Existing
signed-link, embedded and custody route tables continue to classify select/export.

The new CSV, grouped-output, presenter/Meet-context, Next-review and leave action
cases were observed failing before their implementations. Mutation entries break
leave identity/round and accepted-estimate guards. Presenter/Meet read only the
authorized envelope and accepted sibling values; pre-reveal vote fixtures remain
invisible. PostgreSQL retention/backup is the archive contract, not a new import
format. No provider receipt projection, completion check, screen-reader exercise,
software-keyboard exercise or unfamiliar-observer validation is established here.
An isolated Chromium run exercised exact-child Next review, leave-unestimated,
parent/sibling presenter labels, grouped end/reopen and both themes at 320 CSS px
with 100%/200% text sizing. It detected overflow from the new leave action, which
was fixed and rechecked at a 320px document width; its target is at least 44px.
These bounded checks do not simulate a real software keyboard or establish
contrast, screen-reader operation or unfamiliar-observer usability. Exact local
commands and manual limitations are recorded in the pull request.

The focused continuation fixture was also archived with PostgreSQL `pg_dump -Fc`
and restored into a unique disposable database. The stories/dependencies/
sessions/votes projection hash matched, retaining context 13 and planning
3/5/blank; the disposable database was dropped. This fixture round-trip is not
an operator disaster-recovery exercise or a check of external secrets.
Review regression tests cover reference-only parents in Meet, presenter and
Next round review; all three failed before title/ref fallback was corrected.

The sibling editor uses only the authorized room envelope and the existing
facilitator-owned dependency action. It submits the complete active graph against
parent graph/content and retained-child content revisions. Selected unavailable
endpoints stay visible for review; saved unresolved edges persist until explicit
retirement. Reversing direction previews removal/addition and requires separate
acknowledgment. Local sibling navigation only expands reading; it sends no Deal,
estimate, scope or vote action. No new route or server projection is introduced.

`web/src/components/StoryDependencies.test.tsx` was observed failing before the
editor existed, and the disappearing-endpoint regression failed before Save was
blocked for an unavailable unsaved choice. It covers multi-select/save/reopen,
removal/reversal, same-title IDs, named server rejection, latest/mine review,
retained removed/unavailable links, whole-graph preservation, local navigation,
Escape focus and authority loss/redaction. Automated axe coverage checks native
control semantics; browser and verification outcomes are recorded in the PR.
These checks add no screen-reader, unfamiliar-observer or provider evidence.
