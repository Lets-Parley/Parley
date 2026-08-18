# Roadmap

This roadmap outlines the current direction of Parley.

It is not a guarantee of delivery dates or scope. Priorities change with
feedback, technical constraints, and whatever turns out to matter once people
are actually using the thing.

For implementation status, see the GitHub Project:
[Parley Roadmap](https://github.com/orgs/Lets-Parley/projects/1)

## Now

Work in progress or expected in the current development cycle.

Nothing is in progress right now. The next thing to start is under **Next**.

## Next

Accepted work, likely to be picked up after current priorities.

### An extensible core

Adding a ceremony to Parley currently means touching the router, a database
constraint, a registry populated at package initialisation, and a ternary in the
frontend. This makes session kinds a real extension point, so a retrospective or
a story map is code someone adds rather than surgery on the core.

Worth doing on its own merits: it also fixes a migration-versioning bug, gives
the two existing kinds one shared authorization path instead of two
reimplementations, and stops an unknown session kind from silently rendering the
wrong room.

- Status: Backlog
- Target: v0.3.0
- Tracking: [#8](https://github.com/lets-parley/parley/issues/8)

## Later

Accepted direction, not currently scheduled.

### A plugin system

Extend Parley without forking it — integrations, AI features, meeting notes,
themes, and whole ceremonies, installed by the operator and running under
capability grants they approve. Plugin code is sandboxed WebAssembly with no
sockets and no database access; everything it reaches goes through a host
function that checks the grant first.

Depends on [#8](https://github.com/lets-parley/parley/issues/8).

- Status: Backlog
- Tracking: [#9](https://github.com/lets-parley/parley/issues/9)

### The rest of the ceremonies

Retrospectives with grouping and dot voting, action items that outlive the
meeting, user story mapping, a sprint board, async standups, team health checks.
The meetings a delivery team already runs, in the tool they already have open.

Some of these will arrive as plugins rather than core features, which is rather
the point of the two entries above.

- Status: Backlog

### A collaborative whiteboard

An infinite canvas with sticky notes, shapes, connectors, frames, live cursors,
and comments — and every ceremony above able to run on it.

This is the largest single bet on this page and deserves an explicit decision
before anyone starts: the document engine underneath it is infrastructure, not a
feature, and Parley either grows into a whiteboard or deliberately declines to.

- Status: Backlog

## Exploring

Ideas under consideration, not committed to.

- Boards that work offline and merge on reconnect — a genuine advantage for a
  self-hosted tool, and nearly free once a conflict-free document engine exists
- Retro synthesis and meeting recaps, with a bring-your-own model endpoint so
  nothing leaves the instance
- Two-way issue sync with Jira, Linear, and GitHub
- Replaying how a board or a ceremony actually evolved
- Signed single-purpose links — vote on this story, add your standup — that
  need no login at all
- Audit logging, retention policies, and SSO group-to-role mapping
- White-label theming, for anyone hosting Parley on someone else's behalf

## Completed

### v0.2.0

- Sign-in through any OpenID Connect provider, with `AUTH_MODE=open` unchanged
  as the default
- A fix for a room-code throttle that could be bypassed when Parley was reachable
  directly — [upgrade from 0.1.0](https://github.com/lets-parley/parley/releases/tag/v0.2.0)
- Estimates validated against the session's own deck
- A new look: chart paper and navy ink, with tabular figures for vote counts

### v0.1.0

- Planning poker: story queue, four decks, hidden votes, deck-aware statistics
- Daily standup: round-robin with a per-person timer and carried-over updates
- Spaces with memorable links, a roster, and session history
- Room codes, with per-address throttling on wrong guesses
- CSV export
- A documentation site at [letsparley.io](https://www.letsparley.io)

## Feature requests

Have an idea? [Open an issue](https://github.com/lets-parley/parley/issues/new).

Being discussed here does not mean a feature has been accepted for
implementation — the Status field above is the honest signal.
