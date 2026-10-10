# Split publication receipt boundary

October 10, 2026; implementation scope: #797. Provider publication is disabled.
`internal/poker/publication` is a host-only service, exercised with a deterministic
provider fake. No router, configuration flag, credential store, plugin grant or
production adapter exposes it. #798 must supply a verified scoped provider and
its separately authorized integration surface before anyone can publish.

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
