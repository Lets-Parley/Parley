# Security

## Reporting a vulnerability

Do not open a public Issue or Discussion. Use
[GitHub private vulnerability reporting](https://github.com/lets-parley/parley/security/advisories/new)
when the repository offers the report form, or email
[security@letsparley.io](mailto:security@letsparley.io). Private vulnerability
reporting is the intended project setting; this document does not claim that an
external GitHub setting has already been enabled.

Include the affected version, deployment context, impact, reproduction steps,
and any suggested mitigation. A proof of concept helps but is not required. Do
not include secrets or data from an instance you do not own or have permission
to test.

The project aims to acknowledge a report within **five business days**, complete
initial triage within **ten business days**, and coordinate disclosure within
**90 calendar days**. These are response targets for a small, volunteer-run
project, not an on-call support contract. We will share material changes to the
assessment or timeline with the reporter.

If a fix ships, you will be credited in the release notes unless you would rather
not be.

## Supported versions

Only the latest patch release in the current minor series is supported. Older
patch and minor releases do not receive backported security fixes.

| Version | Supported |
|---|---|
| 0.6.1 | Yes |
| 0.3.0, 0.2.2, 0.2.3 | No — superseded |
| 0.2.0, 0.2.1 | **No — have a known vulnerability, see below** |
| 0.1.0 | **No — has known vulnerabilities, see below** |

## Known vulnerable versions

**v0.1.0, v0.2.0, v0.2.1 — a disconnect during a broadcast could kill the
server.** Every release before v0.2.2 could be crashed remotely by an ordinary
client disconnecting at the wrong moment. Closing a browser tab while the room
was broadcasting could send a frame on an already-closed channel, and the
resulting panic ran in a timer goroutine with nothing above it to recover —
so the process exited, taking down every room on the instance, not just the
one the client was in. No authentication was required beyond whatever it takes
to join a space, and no unusual client behaviour: a normal tab close at an
unlucky moment was enough.

Fixed in v0.2.2. Denial of service only — no data disclosure, no write access,
and unrevealed votes were never exposed by it. Upgrade to v0.2.2; there is no
configuration-level mitigation, though an instance behind a proxy that restarts
it automatically will recover on its own.

**v0.1.0 — room-code throttle bypass.** When Parley was reachable directly
rather than through a trusted proxy, the per-address limit on wrong room-code
guesses could be evaded, making a six-character code brute-forceable. Fixed in
v0.2.0 by making proxy-header trust opt-in via `TRUST_PROXY_HEADERS`.

No vulnerable tag or container image is ever **moved** onto fixed code.
Retagging would silently change what a version means for anyone who had already
pulled it, and would break digest verification. A clearly-labelled bad version
is safer than a mutated one, so v0.1.0, v0.2.0 and v0.2.1 all still point at the
code they shipped with.

v0.2.2 is the floor for both; upgrade to the current release, v0.6.1.

To confirm an upgrade actually took effect, ask the running instance which build
it is on: `curl -s https://your-parley/version` answers `{"version":"0.6.1"}`.
The endpoint is unauthenticated and does not touch the database on purpose, so
it answers even when the instance is otherwise unhealthy. Details:
<https://www.letsparley.io/operations/runbook/#which-version-is-this-instance-running>.

## Security model, in one paragraph

Parley's access boundary is a shared room code per space. Any member can rotate
or remove that code; inside a session, the facilitator alone creates, edits,
reorders, selects, and deletes stories and controls the meeting, while ordinary
members may vote or write their own standup entry. Room codes are stored
readable on purpose, so a database dump discloses them. Vote secrecy before a
reveal is enforced in the serializer, so unrevealed votes are absent from API
responses, WebSocket frames and CSV exports alike. Active WebSockets revalidate
their shared-store session at least every 30 seconds and close with policy code
1008 when a token is revoked or expires; logout disconnects the token's sockets
synchronously.

`AUTH_MODE=open` is suitable only for a trusted network. A public deployment
needs a space passcode or external SSO/authentication proxy plus ingress abuse
controls. OIDC identifies people but does not replace space membership.

The full model, threat model, and every known gap are documented at
<https://www.letsparley.io/security/>. The gaps are listed at
<https://www.letsparley.io/known-limitations/> — please read that before
reporting a missing feature as a vulnerability.

## What is not a vulnerability

These are documented, deliberate, and not bugs:

- **Room codes are readable in the database.** By design; a code is meant to be
  read off the space page and passed on.
- **Any member can rotate or remove a space's room code.** There are no space
  owner or administrator roles.
- **Story-queue control is facilitator-only.** Ordinary members retain voting
  and their own standup entries.
- **Anonymous participation.** That is the default product.
- **No general-purpose ingress rate limiter.** Parley limits room-code guesses,
  open-mode identity creation, and resource counts. Apply connection and request
  abuse controls at the ingress too.
- **No HSTS or Permissions-Policy header.** Parley does not terminate TLS; set
  these at your reverse proxy.
- **A session cookie is not bound to an address or device.**

Reports about a Parley instance someone else operates should go to that
operator, not here.
