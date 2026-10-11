# Split publication receipt boundary

October 10, 2026; implementation scope: #797. Provider publication is disabled.
`internal/poker/publication` is a host-only service, exercised with a deterministic
provider fake and a host-only GitHub.com adapter. No router, configuration flag,
credential store or plugin grant exposes it. #798 still requires the complete
scoped credential path, consent-review interface and estimate/counting gates.

## Review and retained data

Preview derives selected child titles/notes, accepted cards, mapped values,
parent disposition and every sibling edge from the authorized room. Approval
requires the observed fingerprint and stores immutable review/step records.
The fingerprint binds org/space/room/principal, parent and child content/scope,
accepted values, complete graph, deck, destination/type/parent/field, connection
generation, mapping and capability. Changed input requires new review. A newer
review supersedes prior dispatch; old receipts remain readable. Review does not
save or change a Poker estimate and is separate from #768's estimate-save task.
#768/#769/#772 remain open; their Jira surfaces are not claimed implemented.

Every service entry point checks the owning org, space, Poker room, current
facilitator, live room and org membership, and absence of a signed-link identity.
Receipt inspection and read-only verification allow ended rooms; approval and
writes require an active, nonretired room. Receipt content is an explicit
projection for authorized reviewers, with no provider errors, credentials,
votes or participant names. No receipt is put in shared state, CSV, frames or
custody projections. An adapter must preserve guest/embedded restrictions and
resolve credentials through the trusted host scope, never a client-supplied ID.

## Delivery and uncertainty

Each selected child gets separate create, native-parent and estimate receipts;
every graph edge gets its own dependency or removal receipt. Unselected,
unavailable or uncreated endpoints stay Waiting for issues. A blank accepted
estimate permits a readback of blank only: it does not permit writing or clearing
an unexpected provider default. Counting requires verified parent exclusion;
parent clearing, fallback source references and restoration are not implemented.

Create operation identity is stable per local child/destination, including
across reload, closure and fresh review. Changing issue type cannot recreate an
already confirmed child. Directed-pair intent has a separate identity for each
graph revision so restoring a removed relationship cannot reuse its old receipt.
All removals must be confirmed before additions run, including a reversed pair.
One failed sibling edge does not erase a confirmed edge or recreate endpoints.

Session row locks serialize review and dispatch claims before target fencing.
A durable Unknown intent and one-minute lease precede provider calls. A second
runner cannot take a live lease. Result acceptance checks current authority,
review and capability again and fences expired/replaced leases. Unknown
successor targets remain blocked. Read-only Verify can reconcile an old unknown
operation after local content changes without authorizing another write.
Inspect must resolve the create operation identity or exact directed pair/value;
only authoritative, definitive absence permits a write. For an estimate, a
nonmatching readback must also establish that the currently approved baseline
still permits that exact field write; unrelated remote edits require review.
Known readback and permission to mutate are separate typed outcomes; a provider
that cannot authorize the write leaves a Failed receipt without dispatch. An HTTP success alone
never confirms a receipt. Provider requests have a 15-second deadline; one run
makes at most one mutation per step, without an automatic retry loop.

A provider must honor cancellation and report Unknown whenever late/in-flight
requests could still commit, or when identity/readback is incomplete. It must
validate approved type, native parent, exact dependency direction, field and
mapped value, paginate bounded readbacks and omit comments/ancillary writes.
This host cannot make an already transmitted request atomic with Postgres or
promise exactly-once creation, relationship atomicity, remote ordering or
conflict-free overwrite. Live adapter tests remain required.

Closure, local removal, connector disable and kind retirement retain operation
identities, receipts and cleanup intent. Reopen requires current review. Nothing
here deletes remote issues, restores parents, sums estimates, mirrors completion
or clears success after a partial failure. Session/space deletion follows local
retention and cascades these records; connector uninstall has no foreign key to
these host records and cannot delete publication history.

## Evidence and outstanding checks

`internal/poker/publication/publication_test.go` covers two-org substitutions,
wrong space/current facilitator, guest and removed membership, stale content,
accepted scope/value, graph/destination/generation/capability, revoked read
projection, retained identities on closure/disable/reopen, partial blockers,
missing endpoints, lost create receipt, unconfirmed HTTP success, exact removal,
reversal/restoration, replay, successor fencing, concurrent and expired leases,
and revocation during or after transmission. Tests use a real isolated Postgres
with `TEST_DATABASE_URL` set and no opt-out. Red-first logs and actual command
results are recorded in the PR; these references alone are not executed evidence.
Guard mutations exercise the newly added authority and orchestration boundaries.

Affected control P-06 remains planned for a live connector. No provider
host/version/permissions, remote type/relationship/field/counting, egress guard,
credential lifecycle, callback authenticity, upstream cache revocation lag or
usable publication UI has been verified. No production network operation runs
here, and no external cleanup is authorized. Before #798 enables dispatch,
complete all eight integration acceptance criteria and #796's live gates,
including two-org credential/target substitutions, embedded/guest refusal,
provider read/write consent, mutation/replay limits and secret-leak checks.
Mixed-version rollout must keep dispatch disabled until every serving worker
supports this contract. Backup restore must reconcile post-backup revocations
and in-flight effects before resuming external work.

## GitHub native adapter preparation

The adapter supports ordinary independent issues, native parent attachment with
`replace_parent: false`, exact sibling `blocked_by` addition and removal. Numeric
REST issue IDs are resolved from the approved repository; they are never confused
with repository issue numbers. Parent and dependency receipts require reciprocal
readback. Dependency endpoints must both be native children of the approved
parent. An inaccessible object, mismatched ID, partial reciprocal relationship,
pagination cap or ambiguous response remains Unknown. Remote graph validation is
not a promise about hidden upstream edges; production remains gated.

The trusted host resolver must bind the entire scope, generation, repository,
read consent and write consent, and resolve fresh on every operation. No connector
store or credential lifecycle is supplied here. The API origin is fixed to
`https://api.github.com`, version `2026-03-10`; the existing fetcher screens and
pins DNS, caps responses at 1 MiB and follows no redirects. Readback is bounded
to ten pages of 100 objects. Requests are capped at 64 KiB; approved issue bodies
are capped at 60,000 bytes. Tokens and provider response bodies never enter error
messages, receipts or projections.

Each create's actual reviewed body includes its stable operation marker. The
persisted lease claim's incremented attempt is passed to the provider; the first
claim or a prior definitive Failed outcome can transmit the exact mutation.
Subsequent unknown missing identity stays Unknown,
even if listing returns no matches. A found create must match exact title, body,
issue type and repository identity. No search/list absence is claimed proof of
noncreation. Restart after transmission, lost responses, marker changes or
inaccessible created issues require reconciliation or manual review rather than
recreation. A crash after claim but before transmission may also require manual
review; the adapter never infers that a missing response proves no write. Confirmed receipt retention remains the host engine's responsibility.

Authorized synthetic proof on October 10, 2026 used `jacorbello/jarvis` on
GitHub.com with ordinary untyped issues: parent [55](https://github.com/jacorbello/jarvis/issues/55),
API [56](https://github.com/jacorbello/jarvis/issues/56), permissions
[57](https://github.com/jacorbello/jarvis/issues/57), and UI
[58](https://github.com/jacorbello/jarvis/issues/58). The adapter created and read
back all four, attached/read back all children, confirmed API and permissions
blocking UI in both directions, removed API → UI before adding/readback of UI →
API, then removed the synthetic edges and closed every synthetic issue. No
meeting content was used and no remote issue was deleted. API relationship
readback does not establish manual visual/browser usability evidence.

The opaque maintenance credential was authorized only for this synthetic proof;
it is not a production publication connection. Project queries were refused for
missing `read:project`, so no estimate, Project membership, blank/default behavior,
parent-counted view or estimate write was tested live. Estimates return Unknown
without any request. Whole-engine approval still requires a complete verified
field/counting capability and is unavailable for this destination. P-06 remains
planned; the synthetic native proof does not complete connector acceptance.
