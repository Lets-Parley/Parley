# Roadmap

This roadmap outlines the current direction of Parley.

It is not a guarantee of delivery dates or scope. Priorities change with
feedback, technical constraints, and whatever turns out to matter once people
are actually using the thing.

For implementation status, see the GitHub Project:
[Parley Roadmap](https://github.com/orgs/Lets-Parley/projects/1)

## Now

Work in progress or expected in the current development cycle.

### A room everyone can actually use

A live room updates itself constantly, and until recently none of those updates
announced themselves. A screen-reader user could not tell that a reveal had
happened, who had voted, or whose turn it was in the rotation — and the "voted"
signal was carried by colour alone. That is not a degraded experience, it is an
excluded one.

Every seat state and the revealed result now carry a text equivalent, the
standup rail says whose turn it is out loud, the member card sits on the native
`<dialog>` so focus behaves without a hand-rolled trap, and a contrast audit
lifted three light-theme tokens over the threshold. Every control in a room has
since been walked with the keyboard, and the two places where a group opacity
wrapper dropped otherwise-legible text below the contrast threshold now clear
AA in both themes.

- Status: Complete, shipping in v0.3.0
- Target: v0.3.0
- Tracking: [#47](https://github.com/lets-parley/parley/issues/47)

### An avatar you'd actually keep

Every seat used to be initials on a hue derived from the user id, and two people
who share initials were two near-identical chips. Picking a mark fixed that: a
nautical crew and a dev-culture pack, drawn as flat silhouettes so the disc keeps
supplying the identity colour.

The mechanism is sound but the drawings are not the standard the rest of the
interface is held to. Rather than commissioning a set, the marks are replaced
with a professionally-drawn open-source one — CC0, no attribution — pre-rendered
and committed, so there is no new runtime dependency and a seat still stores one
short id. One set of art at every size, chosen in the same dialog as today.

- Status: Shipped in v0.5.0; follow-up work in v0.5.1
- Target: v0.5.1
- Tracking: [#38](https://github.com/lets-parley/parley/issues/38), [#253](https://github.com/lets-parley/parley/issues/253)

## Next

Accepted work, likely to be picked up after current priorities.

### Switchable poker

Parley already ships four decks, and they are enough to run most rooms. The
problem is everything they cannot express: teams that want to carry their own
deck and keep it stable across sessions; rooms where a vote can stay open so a
distributed team estimates when they can; observers who watch the discussion but
do not participate in the vote.

Switchable poker is the first slice that makes planning poker feel like it was
made for the way a team already works, rather than asking the team to work the
way the tool expects. A deck becomes something you choose and own, not a global
constant baked into the server.

- Status: Backlog

### Honest ceremonies

Two changes that make ceremonies tell the truth without turning facilitation
into a scoreboard.

#### Yesterday's promise

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

#### A meeting that ends

A session can be given a limit — a length, a number of stories — and when it
runs out the room says so and publishes what it did not get to. The unfinished
list is the artifact, and it is meant to be uncomfortable: a refinement backlog
written from evidence rather than from memory.

No tool that sells seats will ever ship this, which is reason enough.

- Status: Backlog
- Target: v0.3.0

### Signed links

Some participation should be named but not account-bound. A person should be
able to vote on this story, add their standup update, or leave one piece of
context without first becoming a user the instance has to remember.

A signed link is a capability, not a login: it does one thing, for one room, and
expires. That makes it safer than "just make it public" and more honest than a
shared passcode that quietly becomes a second identity system.

- Status: Backlog

### Take the whole instance with you

`parley export` writes every space, session, estimate, vote, and standup entry
to a single versioned archive, and `parley import` reconstitutes it on another
host. Data ownership is a claim until it is a file you are holding.

A database dump is not portability, it is coupling. This is also the backup
story for the many people whose backup story is currently nothing at all.
Export lands first and on its own — it is half the work and most of the trust.

- Status: Backlog
- Target: v0.3.0

### Somewhere for spaces to live

A space belongs to the instance and to nobody else. Slugs are unique across the
whole database, so two teams that both name a room "Platform Team" collide and
the second one is told the name is taken by a space it cannot see. When the
person who made a room leaves, nothing can be done with it: it cannot be
renamed, reassigned, or cleaned up, because space owner is the highest thing
there is. And a new starter cannot find their team's standup without somebody
sending them a link and a passcode.

Organizations put a level above spaces. Membership comes from the identity
provider that already knows which team someone is on, so there are no invitation
emails and Parley goes on storing a name and nothing else. Belonging to an
organization does not put you in its rooms — joining stays something you choose
to do — but it does let you find the ones that want to be found.

An organization admin gets custody without access. They can rename, archive,
and clean up any space, including private ones, and hand a room whose owner has
left to somebody still in it. They cannot read a vote, a standup entry, or a
note, and they cannot put themselves in a room in order to. Private means
private from your colleagues; it has never meant private from whoever runs the
server, and the documentation will say so plainly rather than let people assume
otherwise.

- Status: Backlog
- Target: v0.5.0
- Tracking: [#203](https://github.com/lets-parley/parley/issues/203)

## Later

Accepted direction, not currently scheduled.

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

This work is an unlock: it is the boundary that makes a plugin system and
storage backends feasible without turning every feature into a cross-cutting
rewrite.

- Status: Backlog
- Tracking: [#8](https://github.com/lets-parley/parley/issues/8)

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

### Hosted / Cloud Parley

Some teams want Parley, not Postgres. They are willing to pay for the tool, but
not to operate it: upgrades, backups, and the responsibility that comes with
being the person who owns the instance.

Hosted Parley is accepted long-term direction, but it is not part of the first
slices. A self-hosted tool should be excellent on its own terms before it grows
an operational footprint that can drown out product work.

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

Several of the Exploring ideas below — issue sync, chat integrations, meeting
recaps — are likely to become plugins once [#8](https://github.com/lets-parley/parley/issues/8) exists.

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
- Spaces a creator can open to anyone, no sign-in required, on an instance
  that otherwise requires an identity provider
- Vote with the work — estimate from the ticket itself, not a copied title
  (wants [#8](https://github.com/lets-parley/parley/issues/8))
- Stance, not a number — confidence or risk alongside points
- A room that dies with the meeting — the session ends when the calendar event does
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
