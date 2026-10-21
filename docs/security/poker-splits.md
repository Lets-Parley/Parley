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

The inline dependency editor and grouped continuation use the same local boundary.
The host publication service records reviewed receipts. Its HTTP routes are
registered under `/api/sessions/{id}/publication` in `internal/api/router.go`,
and `internal/api/publication.go` selects the production GitHub provider when
encrypted secret storage is configured; without it the connection status
reports unavailable and preview, approve, run and verify answer 503. The
fake-provider tests do not prove live delivery.
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
receipts and provider authorization require separate delivery evidence and must
not be inferred from these local graph checks.

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
No live provider capability or completed ASVS assessment is claimed by these
scoped checks. The receipt service is tested separately with a fake provider.


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

The composed workflow and rollout evidence, including unresolved manual product
gates, is recorded in [Poker split workflows](../verification/poker-split-workflows.md).
All serving writers must be upgraded before split use; additive migrations do
not make older round/graph writers safe.
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

The dependency editor's Chromium check exercised keyboard/touch multi-select,
real saves with a cast vote, opposing-tab conflict recovery, reciprocal local
navigation and Escape focus. At 320 CSS px, both themes and 100%/200% text sizing
keep the document at 320px, targets at least 44px, text contrast at least 4.5:1,
and focus/control boundaries above 3:1. The initial focused label was covered by
the fixed voting tray; compact IDs and immediate scrolling against the measured
tray boundary corrected it, and all four variants were rechecked unobscured.
A component regression covers that focused-label boundary. Text enlargement is
not an actual browser zoom test; real assistive technology, software-keyboard
and unfamiliar-observer checks remain required before broad rollout.

Undo split adds one facilitator-only verb, `undo-split`, on the existing action
route. It adds no route or table; it writes `stories.drafts_parked`, which is
projected to every client as `draftsParked` (see below). It runs inside `withSplit`, so
facilitation, the active room, space membership and unrevoked org membership
are rechecked under the session lock, and it is classified as refused in
`linkGuestActionVerbs`. It reads `poker_publication_steps` scoped by session and
parent, and refuses while a `create` step is `unknown` or `confirmed`. A
`pending` create step no longer blocks: the only writer that dispatches
(`advance` in `internal/poker/publication/run.go`) commits `unknown` under the
session lock before any provider call, so `pending` means never sent. Publication
runs take the same session lock and re-capture the split first, so a creation
cannot be dispatched between that check and the role change; a later run of the
old approval finds the parent is no longer context and pauses, and after the
split is made again its fingerprint no longer matches the advanced parent and
child revisions and it pauses too. No remote call is made and nothing remote is
deleted. A child on the table is cleared only after the same reviewed round
identity adoption demands, the children's votes stay on their rows, and reveal
is reset, so no hidden value reaches the projection or the export. The parent's
own votes and roster from before the split are deleted in the same transaction,
so dealing it again cannot reveal a round nobody is voting in.

`remove-child` applies the same reviewed round identity when the removed child
is on the table; before this change it ended a live hidden round without any
acknowledgment. The 10-child limit no longer counts removed `proposed`
children, and restoring one is checked against the limit, so the number of
retained children that are active or were ever committed still cannot exceed
10; discarded drafts remain bounded by the per-session story quota.

`checkSplitMembership` now share-locks the caller's `org_members` row in its own
statement before the `members` row. `custody.Store.RevokeOrgMember` locks
`org_members` and then `members`; the previous single statement locked them in
the opposite order and the two deadlocked, which Postgres resolved by aborting
one. `Engine.authorize` in `internal/poker/publication/review.go` still locks
`members` before `org_members` in one statement and has the same exposure; it
is unchanged here.

`buildState` reads a revealed round's vote values in the statement that also
reads the session's current reveal flag and story. The caller's session row is
read earlier, so a reset and a new hidden vote between the two reads used to
return the new values under the stale flag.

A create step the provider's own payload rules reject is recorded `failed`
before the lease is claimed unless it is already `unknown`. Before this change
a title within the local 200-character limit but over GitHub's 256 bytes left
`unknown` with one attempt although nothing had been sent, which blocked both
publication and undo for good.

`internal/api/poker_split_undo_test.go` covers the returned roles, kept and
flagged estimates, the cleared leftover flag, the cleared parent round,
untouched removed children and dependencies, summary and CSV counting, each
create receipt state, steps of every other kind, another parent's receipts, an
approved but unsent approval run after undo and after a second adoption against
a counting provider, stale and missing revisions, non-adopted parents,
participant, outsider, signed-link guest, a facilitator and a parent in a
second org, embedded callers, the reviewed and unreviewed table cases, and the
child limit across undo, discard and restore.
`internal/api/poker_child_rounds_test.go` covers the removal review,
`internal/api/poker_split_test.go` the lock order against a held revoke
transaction, `internal/api/poker_test.go` the stale reveal, and
`internal/poker/publication/github_test.go` the rejected title. The original
undo tests were observed failing with `no such action` before the handler
existed. Each test added in this round for a changed behavior was observed
failing before the change or with the change reverted; the regression guards
added beside them pass either way. `scripts/guard-mutation.sh` breaks the revision, adopted-role, both
receipt, both round-review, child-limit, reveal-consistency and pre-lease
guards, and the client rules that hide the action once a creation receipt is in
view or the tracker has refused it, ask before estimating a live round, name
the round a removal ends, and keep a story dealt with drafts votable.
`web/src/components/StoryTree.test.tsx`, `web/src/lib/splitFan.test.ts`,
`web/src/pages/PokerRoom.test.tsx` and `web/src/pages/PresentPage.test.tsx` cover
the confirmations and their initial focus, the in-place refusals, the hidden
action and the two-story removal explanation. The receipt check is exercised
with rows written directly to the table and with a counting fake provider, not
through a live provider.

A facilitator-set estimate on the story whose round is live and unrevealed now
requires `endRound` and the reviewed round identity, and ends that round in the
same transaction; before this change it was written under a running hidden
round with no acknowledgment. A revealed round needs none and is left in place,
which keeps the flat-room save after reveal working for clients that send no
mode. `TestSettingAnEstimateOnTheLiveRoundEndsItOnlyAfterReview` and its flat
counterpart were observed failing first.

Whether drafts are parked behind an ordinary round is `stories.drafts_parked`
(migration 0058, `not null default false`, so existing rows and a replica on
the previous binary behave as before). It is written under `withSplit` by
`park-drafts`, a facilitator-only verb classified as refused for link guests
and covered by the embedded parity test, and under the session lock by
`undo-split`, `adopt` and `select`. It reaches clients through `buildState` as
`draftsParked`. It is a presentation flag about drafts every participant can
already see listed; it carries no vote, estimate or identity and is not read by
any authorization check. `TestPokerParkedDraftsAreRecordedForEveryone` was
observed failing first.

After a confirmed undo the client leaves the split view at once and treats a
story whose drafts are parked as one ordinary story everywhere, on or off the
table: it is never put on stage by itself, the queue shows a draft count that
only the facilitator can press, and reopening goes through `park-drafts`. This
is presentation over the existing flag; no server code, route or projection
field changed for it.

The client no longer requires an answer about leftover scope before a split is
committed. It sends `coverage: "full"` unless a story was named as the leftover,
in which case it sends `coverage: "remainder"` with that story as before. The
`adopt` contract, its validation of `coverage` and `remainderId`, and the
coverage review after removing or restoring an adopted child are unchanged; what
was relaxed is a client-side prompt, not a server check.

Second review round. A facilitator-set estimate that ends a live hidden round
now deletes that round's votes and roster in the same transaction; they used to
stay on the story and were revealed by the next round. `undo-split` deletes the
parent's votes only when it has no accepted estimate, so a Poker-accepted
estimate keeps the round behind it, and it is fenced on the same `children`
revision map as `adopt`. The leftover designation is `is_remainder` on a
`proposed` child, written by the facilitator-only `leftover` verb inside
`withSplit` (classified refused for link guests, covered by the embedded parity
test) and enforced by `adopt`, which refuses a commit that contradicts a named
draft. `park-drafts` refuses to park where no draft exists, and the flag is
cleared with the last draft. When a revealed round is superseded while its
state is being read, `buildState` now returns `session.ErrStateSuperseded` and
the envelope builder re-reads the session row, so no frame says `revealed` with
the votes withheld. Discarded drafts are retained rows and keep counting
against the per-session story quota.
On the client, Ctrl+Enter commits a split only from the story field or with no
text field focused, a commit never auto-deals a story that would need a
fresh-round review, discarding two or more drafts asks first, and the
single-key `S` shortcut added earlier in this change is removed. After a
committed story is removed or restored the client re-sends `adopt` with full
coverage when no leftover is named; with a leftover it leaves `needs-review`
in place behind an optional control, because that state still pauses
publication until coverage is recorded again.

Parent estimates. Migration 0059 widens the `estimate_provenance` check to
admit `story-total` and adds the nullable `parent_estimate_answered_revision`;
no existing row changes and a replica on the previous binary never writes
either. `parent-estimate` is facilitator-only inside `withSplit`, refused for
link guests and covered by the embedded parity test. The total is computed on
the server from the active committed children with exact arithmetic and fenced
on the parent revisions, the `children` map and the client's expected sum; it
is the only path that may store a value that is not a card, and only on a
`context` parent. A committed parent may be dealt and Poker-accepted without
leaving `context`; facilitator-set stays refused there. Neither the answered
revision nor the new provenance carries a vote or an identity. The parent's
estimate is not in any publication step; recording one changes the parent's
content revision and therefore the approval fingerprint, so an earlier approval
pauses rather than sends (`TestParentTotalPausesAnEarlierPublicationApproval`,
a regression guard that passed when written).

QA gate. After the client began re-sending `adopt` to confirm coverage, removing
or restoring a story while the parent was being estimated with the team ended
that round for everyone without acknowledgment, because `adopt` cleared a
parent that was on the table. A coverage-only `adopt` (committed parent, no
draft) now skips the round review and never changes selection, reveal, round
version or votes; a commit of new drafts keeps the `switchToChildren` contract.
A total is refused while the parent is on the table, and re-sending an
unchanged estimate no longer flags a total.
`TestSplitActionsNeverEndARoundThatIsLiveOnTheParent` covers hidden and
revealed parent rounds across remove, restore, coverage re-confirmation,
declining, leftover, drafting and undo, and was observed failing first.

QA re-test. Two client mechanisms added earlier were unsafe and are now single
helpers with tests and mutations: automatic scrolling cannot move the round's
primary control or the focused element out of the tray-free viewport and does
not run while a text field or dialog has focus; automatic focus movement cannot
land on a control whose activation writes to the room, and committing controls
ignore key auto-repeat. On the server, `select` of a top-level story that has
ever been split requires `freshRound` over votes it still holds, so an undone
ticket cannot be re-dealt with an earlier round's votes hidden under a new one
(`TestDealingAnUndoneTicketOverOldVotesNeedsAFreshRound`, observed failing
first); stories that were never split keep the legacy behavior.

Third QA gate. Card menus focus their container rather than an option that
writes; one capture-phase guard on the room root swallows repeated Enter and
Space on everything except text fields; Reveal, Save and Reset share the
answers' single-flight guard; controls that alternate in one slot have distinct
keys, so a focused non-writing control can no longer become a writing one when
another tab changes the room; and the round is brought into view after a deal
from any scroll position. Each has a mutation entry except the element keys.
