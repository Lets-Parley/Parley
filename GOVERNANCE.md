# Governance

Parley is currently a solo-maintainer project. This document records how
decisions are made now and how responsibility expands when another maintainer
joins.

## Roles

- **Contributors** report problems, join design discussions, improve code or
  documentation, and sign off their commits under the Developer Certificate of
  Origin.
- **Maintainers** triage work, review changes, moderate community spaces, manage
  releases, and administer the project repositories and services.
- **The project lead** is the current maintainer and has final responsibility
  when consensus cannot be reached.

Maintainer status is earned through sustained, constructive contributions,
sound technical judgment, dependable review, and conduct consistent with the
[Code of Conduct](CODE_OF_CONDUCT.md). The project lead appoints maintainers in
a public governance issue after describing the candidate's responsibilities.
A maintainer may step down at any time. Removal for inactivity, security risk,
or Code of Conduct violations is documented publicly when privacy and safety
allow.

## Decisions and work tracking

Use [Discussions](https://github.com/lets-parley/parley/discussions) for support,
questions, and proposals that still need design. Once work is accepted and
actionable, track it in an Issue. Substantial changes should have an accepted
Issue before implementation.

Maintainers seek rough consensus, weighing user impact, security, operational
cost, maintenance burden, and alignment with the roadmap. The project lead makes
the final call when consensus is unavailable and records significant decisions
in the relevant Discussion or Issue.

## Changes and releases

All commits require a Developer Certificate of Origin sign-off. Pull requests
must pass the repository's required CI and DCO checks. Today, with one
maintainer, the documented review policy requires zero approving reviews so the
project is not deadlocked; the maintainer must still use pull requests and may
not bypass required checks. This describes the intended repository policy, not
a claim that GitHub settings have already been enabled.

When a second maintainer joins, protected changes require one approval from an
independent member of `@Lets-Parley/maintainers`, as selected by
[CODEOWNERS](.github/CODEOWNERS). The author cannot approve their own change,
stale approvals are dismissed after relevant updates, required conversations
must be resolved, and owners do not bypass the policy.

Releases follow the documented [release and supply-chain
process](https://www.letsparley.io/security/supply-chain/). Security fixes may
use a private fork or advisory until coordinated disclosure, but the resulting
release still follows the normal integrity checks.

## Security and conduct

Vulnerabilities are handled under [SECURITY.md](SECURITY.md). Confidential
conduct reports go to
[conduct@letsparley.io](mailto:conduct@letsparley.io) under the
[Code of Conduct](CODE_OF_CONDUCT.md). The project lead handles both today; a
maintainer who is named in a report is excluded from its handling whenever
another eligible maintainer is available.

## Continuity and temporary solo-owner exception

The project currently has one trusted organization owner. This is a temporary
continuity exception, not the desired steady state. A second trusted owner must
be added no later than **September 17, 2026**, 30 days after this policy was
adopted. The second owner should have secured recovery credentials and enough
context to restore repository, package, domain, and security-reporting access.

If that deadline passes without a second trusted owner, routine releases and
organization-level settings changes pause until the second owner is added.
Emergency actions needed to contain an active incident or recover project access
remain allowed and must be documented afterward when doing so is safe.
