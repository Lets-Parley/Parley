---
name: parley-security
description: Use when planning or reviewing Parley security boundaries, connectors, CI pruning, releases, recovery, or enterprise assurance claims.
---

# Parley security guidance

Use the checked-out repository as the authority. Locate its root with
`git rev-parse --show-toplevel`; read `AGENTS.md`, `SECURITY.md`, and
`docs/security/README.md`. Do not assume this skill's installed location is
inside the repo. If those files are absent, report the missing context rather
than importing Parley policy into another product. Honor the user's task and
existing authorization; this reference does not authorize deployment, external
sharing, purchases, or an audit.

Read only the task's relevant references:

| Task | Repository references |
| --- | --- |
| Assurance or security roadmap | `site/src/content/docs/security/program.mdx`, `docs/security/control-register.csv`, `docs/security/asvs-5.0.0.csv` |
| Connector or model-facing feature | `site/src/content/docs/security/integrations.mdx`, existing plugin guards/consent copy, guest and embedded route tables |
| CI reduction | Retained-invariant table in `docs/security/README.md`, `.github/workflows/ci.yml`, `scripts/guard-mutation.sh` |
| Release or upgrade | `site/src/content/docs/security/supply-chain.mdx`, `site/src/content/docs/operations/upgrading.mdx`, `.github/workflows/release.yml` |
| Recovery or incident | `site/src/content/docs/operations/backups-and-recovery.mdx`, `site/src/content/docs/operations/runbook.mdx`, `SECURITY.md` |

Produce a scoped result with the affected boundary, current source/test
references, required negative/failure checks, manual checks, evidence status,
and remaining decisions. For ordinary changes, update only affected records;
do not turn every task into a repository-wide scan.

For connector plans, use the numbered acceptance criteria in the integrations
page. Include separate import/write-back authorization, scoped token selection,
local object/field permission checks, guest/embedded/admin limits, upstream
permission/deletion and cache lag, callback/webhook authenticity and replay,
SSRF/redirects, and secret/resource limits. Follow the repo's red-first tests
and update operator docs alongside behavior.

For CI pruning, identify the invariant and failure signal of every removed
check. Preserve tenant/object, guest/admin, serializer, session/credential,
browser/SSRF, replay/idempotence, resource, key/recovery, and delivered-artifact
boundaries. Quarantine needs an owner, tracked fix, expiry, and compensating
check. Retain guard mutations. State whether `TEST_DATABASE_URL` was set and
whether the database opt-out was used; existing test files are not run evidence.

For release/recovery claims, distinguish the maintainer's software/release path
from the operator's infrastructure, IdP, storage, backups, keys and incidents.
Review restored post-backup removals, revocations and deletions before exposure.
Database boot is insufficient if secrets cannot decrypt or old grants return.

For assurance, use CSF 2.0, SSDF 1.1, ASVS 5.0.0 Level 2 as a target, and SLSA
1.2 as the pinned baseline. The initial ASVS matrix is partial. Verify the full
applicable Level 1/2 set and exact requirement text before claiming Level 2.
Evaluate every requirement of a specified SLSA track/level, including consumer
verification of digest, authenticated builder, source and build policy. Green
CI, SBOMs and signatures alone support neither level claim. SOC 2/ISO work is
buyer-driven and scoped to the actual organization/operated service; customer
deployments are outside a maintainer's assurance by default.

Example: a buyer asks for “ASVS Level 2 verified” because CI passed. State that
Level 2 is the target, link the partial matrix, identify applicable requirements
and manual/operator evidence still outstanding, and offer the dated factual
review pack. Preserve private evidence and avoid unsupported commitments.
