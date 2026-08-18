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

### A room everyone can actually use

A live room updates itself constantly, and right now none of those updates
announce themselves. A screen-reader user cannot tell that a reveal has
happened, who has voted, or whose turn it is in the rotation — and the "voted"
signal is carried by colour alone. That is not a degraded experience, it is an
excluded one.

Announced state changes, vote indicators that survive without colour, full
keyboard operation of the table, and a focus trap that behaves. Every component
here already ships with a test beside it, so the work is to make accessibility
one more thing those tests assert rather than a one-off audit that decays.

- Status: Backlog
- Target: v0.3.0

### An extensible core

Adding a ceremony to Parley currently means touching the router, a database
constraint, a registry populated at package initialisation, and a ternary in the
frontend. This makes session kinds a real extension point, so a retrospective or
a story map is code someone adds rather than surgery on the core.

Worth doing on its own merits: it also fixes a migration-versioning bug, gives
the two existing kinds one shared authorization path instead of two
reimplementations, and stops an unknown session kind from silently rendering the
wrong room.

It should also settle where storage sits. A session kind is currently handed a
Postgres connection pool directly, which puts the database driver in the middle
of the extension point this work exists to stabilise. Drawing that boundary now
costs a little; drawing it after the interface is published costs a great deal
more.

- Status: Backlog
- Target: v0.3.0
- Tracking: [#8](https://github.com/lets-parley/parley/issues/8)

### Yesterday's promise

Standup already carries what you said you would do today into tomorrow's
"yesterday". It then asks nothing about it. A day's work is never falsified, so
a stuck item can quietly stay stuck for a fortnight while every individual
morning feels fine.

Each turn opens with what you said last time and one question: still on this?
An item answered "no" twice running gets flagged as stuck — the item, not the
person. No streaks, no percentages, nothing that turns a facilitation aid into a
performance record.

- Status: Backlog
- Target: v0.3.0

### A meeting that ends

A session can be given a limit — a length, a number of stories — and when it
runs out the room says so and publishes what it did not get to. The unfinished
list is the artifact, and it is meant to be uncomfortable: a refinement backlog
written from evidence rather than from memory.

No tool that sells seats will ever ship this, which is reason enough.

- Status: Backlog
- Target: v0.3.0

### Take the whole instance with you

`parley export` writes every space, session, estimate, vote, and standup entry
to a single versioned archive, and `parley import` reconstitutes it on another
host. Data ownership is a claim until it is a file you are holding.

A database dump is not portability, it is coupling. This is also the backup
story for the many people whose backup story is currently nothing at all.
Export lands first and on its own — it is half the work and most of the trust.

- Status: Backlog

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

### A parking lot with an owner and a clock

"Let's take that offline" is the most-spoken and least-honoured sentence in any
ceremony. A first-class parking lot refuses to accept the deferral without a
person and a date attached, then puts the item back in front of the room at the
next session until somebody deals with it.

This is the first thing Parley would store that belongs to a team rather than to
a single session, which makes it a fair test of whether the boundary drawn by
[#8](https://github.com/lets-parley/parley/issues/8) is in the right place.
Worth building after that work, not before.

- Status: Backlog

### Postgres becomes optional

One binary and one file on disk, with Postgres an opt-in for teams that outgrow
it. A team of six estimating twice a week should not need a database container,
a volume, and a backup plan before anyone can vote.

Cheap once storage sits behind an interface, and expensive until it does — so
this follows [#8](https://github.com/lets-parley/parley/issues/8) rather than
racing it. Both backends would have to run the whole test suite in CI, or the
two dialects drift and the less-used one quietly rots.

- Status: Backlog

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
