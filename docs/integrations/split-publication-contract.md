# Split publication capability contract

Decision date: October 10, 2026. Tracks [#796](https://github.com/Lets-Parley/Parley/issues/796)
under [#788](https://github.com/Lets-Parley/Parley/issues/788).

## Decision and evidence boundary

Select **GitHub** as the first provider candidate for independent issues, native
parent/sub-issues, dependencies, and an organization Project estimate field.
The authorized proof for this task is local CSV export, as requested by the
maintainer in place of a remote live test. This decision does not authorize a
GitHub adapter, a remote test write, cleanup, or publication from Parley.

The candidate host is github.com (REST api.github.com, GraphQL
api.github.com/graphql). Official documentation was checked on October 10,
2026; current REST examples use API version `2026-03-10`. No destination
organization, repository, Project, field, authentication mechanism, or issue
type has been validated for publication. GitHub Enterprise Server and every
other host/version are untested and disabled. Jira is outside this first
provider decision. GitHub credentials used to maintain this repository do not
constitute consent to publish meeting content.

**Delivery remains disabled; manual export is available.** Completion of this
record means the CSV substitution and capability investigation are recorded.
It does not mean the original remote API→UI, parentage, field, or counting
acceptance criteria passed. Those checks remain an open implementation gate.

## Operations, permissions, and identifiers

The future provider operation allow-list is deliberately narrow:

| Purpose | Candidate operation | Identifier and permission checks |
| --- | --- | --- |
| Read a selected issue | `GET /repos/{owner}/{repo}/issues/{number}` | Approved repository + repository-local number; reject a pull request; Issues read for private resources |
| Create independent work | `POST /repos/{owner}/{repo}/issues` | Issues write; ordinary issue, never a Project draft; selected organization type must be read back |
| Attach parent | `POST /repos/{owner}/{repo}/issues/{parent_number}/sub_issues` | Body `sub_issue_id` is the child's numeric REST `id`; Issues write; selected parent only |
| Read back parent | Parent `GET .../sub_issues`, child `GET .../parent` | Validate both ends against approved repository and the returned numeric IDs |
| Record A blocks B | `POST /repos/{owner}/{repo}/issues/{B_number}/dependencies/blocked_by` | Body `issue_id` is A's numeric REST `id`; Issues write |
| Read back dependency | B `GET .../dependencies/blocked_by`; A `GET .../dependencies/blocking` | Confirm A on B's blocked-by list and B on A's blocking list, with pagination |
| Add issue to selected Project | GraphQL `addProjectV2ItemById` | Project node ID + issue node ID; approved Project write authority |
| Write selected estimate | GraphQL `updateProjectV2ItemFieldValue` | Project/item/field node IDs, compatible field type and current approved mapping |

These are capability requirements, not implemented endpoints in Parley. Issue
number, numeric REST `id`, GraphQL `node_id`, Project number, Project node ID,
item node ID, and field node ID are distinct. Resolve IDs from the bound
objects; never substitute a number in an ID body or trust a client-provided
foreign ID. Preserve returned IDs for readback and ambiguous-result recovery.

The [issue API](https://docs.github.com/en/rest/issues/issues#create-an-issue)
documents issue creation and type handling: setting type requires push access,
and the type may otherwise be silently dropped. No selected type is called
supported until readback confirms it.
The [sub-issue API](https://docs.github.com/en/rest/issues/sub-issues)
requires a numeric child ID and supports parent replacement; replacement is
forbidden here. Create new independent issues only, never reparent existing
work. A native parent relation is distinct from a blocking relation.
The [dependency API](https://docs.github.com/en/rest/issues/issue-dependencies)
defines the numeric blocking ID and the blocked-by direction above. Record
API success separately from UI confirmation in both issue views.

[Projects API guidance](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
uses GraphQL node IDs and field discovery. For a classic PAT, read queries
require `read:project`, mutations require `project`; these are distinct from
repository Issues permissions. An installation mechanism must separately
validate its organization Projects read/write permissions and repository
access. This record selects no authentication mechanism and requests no scope
expansion. Labels, assignees, comments, status, attachments, issue-field writes,
and organization configuration mutation are outside the allow-list.

## Estimates and parent counting

Use the current room's authoritative deck mapping, not string parsing in an
adapter. Numeric destinations accept only finite numeric cards; `½` maps to
0.5, and an explicit numeric zero stays zero. Ordinal decks require an
explicit, approved label-to-single-select-option-ID map. `M` is not 3 points;
`?` and `coffee` never become estimates. Unknown cards, deleted options, wrong
field type, or changed deck disable estimate delivery.

A missing estimate stays blank. Omit a new child's field write when it is
unestimated, and then read back the provider value: a Project automation may
supply a default. A nonblank unexpected default leaves the item manual/pending;
it cannot be described as an agreed estimate. Blank never means zero, clear,
or restoring an earlier value. Clearing an existing value requires separate
approval for that object and field, and a confirmed clear/readback operation.

Choose a **gate**, rather than a warning, for unresolved parent counting.
Keep the parent's historical local estimate. Before publishing an estimated
child set, the selected Project must demonstrably exclude the parent from its
counted estimate view or a separately approved parent clear must be confirmed.
An undocumented filter, an assumption about native parent rollups, or a hidden
spreadsheet total is insufficient. Unknown exclusion remains manual/pending.
Do not sum child cards, alter parent history, auto-roll up, or auto-restore a
parent after partial success. The counting policy must name the specific
Project view/report and who approved exclusion or clearing.

A textual parent fallback requires separate approval. Label it **Source
reference** and record that native parentage was not established. It cannot
stand in for native blocking or clear the dependency gate. No fallback has
been approved in this run.

## Delivery gates and partial results

Import/read consent is separate from consent to create, attach a parent, add
dependencies, or write/clear estimates. Each approval binds current org,
space, room, authorizing principal, connection generation, repository, parent,
Project, and field. A successful read/probe is never publication approval.

| Unverified or refused condition | Required outcome |
| --- | --- |
| Host/version or authentication unsupported | Disable all remote delivery; retain local record and export |
| Issue type missing, silently dropped, or create permission missing | Disable create; explain manual/pending |
| Parent unavailable, already parented, inaccessible, or replacement required | Disable attachment; no automatic textual fallback |
| Numeric ID mismatch or reverse dependency direction | Disable relationship write; reread bound endpoints |
| Remote cycle, hidden/inaccessible wider graph, conflicting parent/configuration | Stop affected relationship; local acyclicity is insufficient |
| Project/field unavailable, forbidden, incompatible, or default unexpected | Disable estimate write; keep card label locally |
| Parent counting unknown | Gate estimated child delivery until explicit validation |
| Revoked membership/connection, changed destination or authority | Cancel undispatched work; fresh consent required |
| Timeout after sending, rate limit, or partial success | Record per-operation outcome; reconcile before retry, never duplicate create |

Record create, parent, each dependency, project membership, estimate, and
counting evidence independently. An issue created successfully does not make
its relationships successful. Do not delete a remote issue to simulate a
transaction or report "synced" from an HTTP success alone. Retain local
history and sanitized receipts; remote cleanup has its own consent.

## Security acceptance checks before an adapter ships

All eight [integration criteria](../../site/src/content/docs/security/integrations.mdx)
apply. These checks are planned acceptance checks, not executed connector tests:

1. List each allowed operation above and obtain separate read/write consent.
   Attempt create/relationship/estimate work under read-only consent: refuse.
2. Resolve connection credentials through authorized org/space/room scope.
   Substitute foreign-org, repository, parent, Project, and field IDs across
   requests and queued work: indistinguishable refusal, no foreign discovery.
3. Recheck current membership, role, room and provider object/field access on
   each dispatch/retry. Signed-link guests, embedded principals and custody
   admins gain no external-write authority from participation/management.
4. Recheck upstream access before use; define an actual maximum cache lag before
   retaining provider content. No provider-content cache or revocation-lag
   guarantee is selected here. Revoke upstream/local access between enqueue and
   dispatch; refuse new work. An already transmitted write may be unknown.
   Backup restoration must not revive disconnected authorization.
5. If callbacks/webhooks are introduced, verify provider signatures and bound,
   expiring, single-use state; reject forged/replayed/reordered events that try
   to change tenant or grants. No callback/webhook is required by CSV proof.
6. Use fixed approved API origins and the existing fetch guard for any plugin
   HTTP path. Reject private DNS results, rebinding and unsafe redirects,
   including redirects that forward credentials. Bound bodies, deadlines,
   pagination, retry counts, queues and quotas before implementation enables
   network work; no increased sandbox budget as a workaround.
7. Keep host-owned encrypted credentials out of frames, bundles, exports,
   receipts, logs and diagnostics. Exercise corrupt ciphertext, wrong binding,
   revoked credentials and interrupted rotation. Exporting a CSV grants no
   authority to upload it elsewhere.
8. Retain red-first negative tests and opt-in manual evidence for selected
   configurations. In addition to the preceding cases, cover wrong numeric ID,
   missing type, forbidden field, blank/default mismatch and unsupported
   host/version. Jira's missing link type/reversed inward/outward labels are
   excluded with Jira delivery disabled, not claimed passing GitHub fixtures.

Affected security record: `P-06` (integration scope and upstream removal)
remains **planned**. This document provides scoped requirements and local
serialization evidence; it verifies no connector security control.

## Reuse and scope review

[#766](https://github.com/Lets-Parley/Parley/issues/766),
[#767](https://github.com/Lets-Parley/Parley/issues/767), and
[#770](https://github.com/Lets-Parley/Parley/issues/770) were inspected on
October 10, 2026 and are open. #766's explicit numeric mapping and unsupported
configuration policy, #767's scoped connection generations/revocation and
host-owned credentials, and #770's bounded operations/typed outcomes are
requirements worth reusing when implemented. They supply no working GitHub
connection or adapter today. Their parent #765 remains estimate-only; this
record does not add create/parent/dependency capabilities to it.

Current source reuse is narrower: `internal/poker/deck.go` owns deck numerics;
`internal/poker/csv.go` renders visible story labels;
`internal/session/csv.go` sanitizes cells;
`internal/api/export.go` serializes an authorized redacted envelope;
`internal/plugin/fetch.go` and `hostfn.go` enforce outbound/grant boundaries.
Existing plugin session endpoints are not general tracker publication APIs.
No adapter, generic connection framework, full sync, external/cross-parent
blocker support, completion retrieval or reparenting is implemented here.

## CSV proof and remaining manual procedure

See [local proof](csv-proof.md) for the executed renderer evidence and its
limits. CSV is a manual review artifact; the current six-column export does
not encode native parentage, dependencies, Project IDs, or a counting policy.
Keep that metadata in the local record; do not infer it from row order or title.

To open the remote gate later, an authorized operator must name the exact
host/API version, organization/repository, independent issue type, parent,
Project/view and field type/ID, deck mapping, counting rule, publication identity
and permissions. Record separate read/create/parent/dependency/estimate consent
and any approved clear/cleanup operations without publishing credentials.

In a dedicated test destination, create independent A and B, attach them to
the approved parent without replacing existing parentage, and record A blocks
B. Read back created issue IDs/type, parent relation from each side, and both
dependency lists; visually confirm "blocks" on A and "blocked by" on B,
separately from their parent UI. Add Project items, write approved estimates,
and read their exact field values back. Exercise blank/default and ordinal
cases, and validate the counted view excludes the historical parent or its
separately approved clear. Record conflicting/forbidden configuration outcomes,
sanitized responses, tested commit, date and screenshots. Wider remote cycles
or hidden edges must remain an explicit limit. Nothing in the local CSV proof
replaces this procedure, authorizes deletion, or claims tested native support.
