# Security

## Reporting a vulnerability

Please report security issues through a
[GitHub security advisory](https://github.com/lets-parley/parley/security/advisories/new),
not a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required. You will get an acknowledgement, and a decision on
whether it is a real issue, as quickly as one maintainer reasonably can — this is
a small project and there is no on-call rotation behind it.

If a fix ships, you will be credited in the release notes unless you would rather
not be.

## Supported versions

Only the latest release is supported. There are no backported security fixes.

| Version | Supported |
|---|---|
| 0.2.2, 0.2.3 | Yes |
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

Upgrade to v0.2.2.

## Security model, in one paragraph

Parley's access control is a shared room code per space, not identity. Anyone
holding a code has full participation in that space, and any member can rotate
or remove that code — there are no roles. Room codes are stored readable on
purpose, so a database dump discloses them. Vote secrecy before a reveal is
enforced in the serializer, so unrevealed votes are absent from API responses,
WebSocket frames and CSV exports alike.

The full model, threat model, and every known gap are documented at
<https://www.letsparley.io/security/>. The gaps are listed at
<https://www.letsparley.io/known-limitations/> — please read that before
reporting a missing feature as a vulnerability.

## What is not a vulnerability

These are documented, deliberate, and not bugs:

- **Room codes are readable in the database.** By design; a code is meant to be
  read off the space page and passed on.
- **Any member can rotate or remove a space's room code.** There is no role
  model yet.
- **Anonymous participation.** That is the default product.
- **No rate limiting outside room-code guesses.** Apply it at your ingress.
- **No HSTS or Permissions-Policy header.** Parley does not terminate TLS; set
  these at your reverse proxy.
- **A session cookie is not bound to an address or device.**

Reports about a Parley instance someone else operates should go to that
operator, not here.
