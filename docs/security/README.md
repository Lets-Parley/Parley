# Security program and evidence

Parley's engineering baseline follows the Parley-relevant recommendations in
`plotlens-parley-substrate-security-roadmap.md`, dated October 4, 2026.
This directory records project policy and verification work; it does not assert
that an assessment or audit has passed. The source document's other products,
customer figures, and proposed transfer/recovery architecture are outside this
repository's scope.

The operator-facing [security program](../../site/src/content/docs/security/program.mdx)
defines the framework targets, shared responsibilities, phases, and procurement
boundary. [Integration requirements](../../site/src/content/docs/security/integrations.mdx)
define outbound data flows and acceptance criteria. Actual behavior remains in
the security and operations pages, backed by source and tests.

## Evidence register

[control-register.csv](control-register.csv) is the initial risk and control
register. Owners are responsible roles awaiting a named assignee; they are not
evidence that someone has accepted an exception. The initial source inventory
was reviewed on October 4, 2026 at commit
`94a1772d56b1ff9f7d2b51fae6c469cb3d2f9a90`. It records implementation and test
locations, **not executed verification**. No initial row is verified.

Use these control statuses:

- **planned**: required work or evidence does not exist yet.
- **implemented but unverified**: an implementation reference exists, but the
  recorded checks do not yet establish the full control.
- **verified with evidence**: a dated result identifies the exact tested
  commit/artifact or deployment, method, outcome, and limitations.
- **exception accepted by an accountable owner**: record the named approver,
  rationale, impact, compensating control, expiry, and next review.

Each record carries scope, responsible owner, implementation reference,
verification method, evidence reference/date, exception, and review trigger.
Link one record to CSF functions, SSDF practices, and applicable ASVS IDs;
reuse it for later buyer criteria rather than maintaining duplicate programs.
Keep secrets, exploit details, production configurations, personal data, and
customer evidence privately. A public row may point to a private evidence ID.

For a security-sensitive change, identify the affected records before coding.
Update references and invalidate stale verification after changes to identity,
tenancy, guests, serialization/export, connectors, plugin grants, model routing,
retention, keys, administration, migrations, or releases. Unrelated changes
need no framework paperwork.

## ASVS applicability and verification

[asvs-5.0.0.csv](asvs-5.0.0.csv) starts a **partial** requirement-to-test matrix
using exact IDs from the [version-pinned OWASP source](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.json).
The short focus labels are navigation aids, not replacement requirement text.
An assessment must check the full upstream requirement. This seed prioritizes
current trust boundaries; it is not the complete applicable Level 1 and Level 2
set and cannot support a Level 2 claim.

Expand it to every Level 1/2 requirement before completing an assessment.
Record applicability by deployment mode (open/OIDC, embedded client, plugins,
and enabled connectors), with a specific rationale for each exclusion. A
documented limitation or deliberately accepted risk is not automatically
not applicable. Identify automated checks separately from manual design,
browser, IdP, infrastructure, and provider configuration review. Any additional
Level 3 controls retained for product risk stay in scope independently of the
Level 2 target.

## Tests retained when CI is reduced

Preserve the invariant and a meaningful failure signal. Reduce duplicate
permutations and repeated setup before removing boundary coverage. Run cheap
authorization and serialization regressions frequently; run relevant stateful
integration/security checks when those boundaries change and before release.
The authoritative gate remains `.github/workflows/ci.yml`.

| Invariant | Minimum negative/failure coverage | Current references |
| --- | --- | --- |
| Tenant and object isolation | Substitute another org's slug/object/install through read, list, mutation, export, jobs, and storage | `internal/api/org_routes_test.go`, `internal/api/plugins_test.go`, `internal/plugin/host_test.go` |
| Identity does not confer permission | Valid identity with wrong role/object; membership revoked; direct admin call; guest and embedded route allow-lists | `internal/api/link_routes_test.go`, `internal/api/embed_routes_test.go`, `internal/api/custody_test.go` |
| Client-safe projections | Hidden votes/authorship and other rooms absent from HTTP, WebSocket, CSV, and plugin frames | `internal/api/export_test.go`, `internal/api/pluginpanels_test.go`, `web/src/lib/pluginBridge.test.ts` |
| Credentials and sessions remain scoped | Wrong issuer/audience, expired/revoked tokens, forged callback, cross-install/cross-space secret | `internal/auth/oidc_test.go`, `internal/api/auth_test.go`, `internal/plugin/secrets_test.go` |
| Untrusted inputs cannot widen authority | Revoked grants stop at the next host call; widening upgrade waits for approval; imported text grants no permissions | `internal/plugin/host_test.go`, `internal/plugin/describe_test.go`, `scripts/guard-mutation.sh` |
| Browser and outbound boundaries | Invalid Origin/CSRF; private or metadata address; DNS rebinding; every redirect; webhook credential forwarding | `internal/api/security_test.go`, `internal/plugin/fetch_test.go`, `internal/plugin/webhook_redirect_test.go` |
| Delivery and resources remain bounded | Duplicate deliveries, concurrent writers, timeout/memory/storage/in-flight caps, retries | `internal/standup/webhook_test.go`, `internal/plugin/actions_test.go`, `internal/plugin/runtime_test.go` |
| Data and keys survive safely | Interrupted migration/rotation, corrupt or wrongly scoped ciphertext, lost key, restored authorization state | `internal/plugin/secrets_test.go`; operator restore exercise still required |
| Delivered releases match approved builds | Altered artifact/digest/provenance or wrong builder/source; boot actual container on empty DB | `.github/workflows/release.yml`, `.github/workflows/ci.yml`; consumer verification exercise still required |

These references identify starting points, not proof that every scenario in a
row is covered. New connectors need forged/replayed webhook tests. New
import/export paths need traversal, malformed/oversized input, and interrupted
write tests. If model-facing features arrive, add malicious-context evaluations
alongside deterministic policy tests; an evaluation cannot replace enforcement.

A quarantined/flaky boundary test needs a tracked fix, named owner, expiry,
failure signal, and compensating check. Removing the sole tenant, guest,
revocation, secret, or restore check is a security regression. Plugin guards
retain their mutation entries. Behavioral changes still require a test observed
failing before the fix, as required by `AGENTS.md`.

## Release, incident, and recovery evidence

For each distributed artifact/variant, retain its source commit, build workflow
and run, digest, authenticated provenance, applicable source/image SBOMs,
verification policy and result, smoke result, and any missing assets. Exercise
failure on a changed digest or unexpected signer/builder/source. Validate the
delivered image/binary, not just the tag or a green build. External source,
release-environment protections, privileged access reviews, and recovery of
release authority require readback or manual evidence; workflow YAML alone
does not establish them. Untrusted PR jobs must stay away from release secrets
and production data. Dependency and secret findings need reachability/impact
triage and owned, time-bound exceptions.

Use `SECURITY.md` for supported versions and private reports. The project
maintains defect triage, regression tests, patches, advisories, and operator
upgrade/mitigation communication. Each deployment operator maintains detection,
containment, session/link/connector credential revocation, evidence preservation,
contacts and escalation, and authorized customer/provider communication.
Neither playbook should put sensitive evidence in a public issue.

Restore evidence records backup age and scope, binary/schema versions, key
availability, actual elapsed recovery time, recovered data checks, and restored
deletion/revocation reconciliation. Operators set RPO/RTO and review them after
schema, key, identity, infrastructure, or retention changes. A backup setting
and an application boot alone do not establish recoverability. See the
[restore runbook](../../site/src/content/docs/operations/backups-and-recovery.mdx).

## Decisions still open

Assign named owners and dates for the full ASVS applicability review, external
release-control readback and SLSA level assessment, consumer verification
exercise, deployment restore objectives/results, integration cache revocation
semantics, and any buyer-specific assurance scope. Record the resulting
decision and evidence in the register. These are roadmap work, not permission
to buy an audit, deploy changes, or share private evidence externally.
