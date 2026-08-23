# Roadmap

This roadmap outlines the current direction of Parley.

It is not a guarantee of delivery dates or scope. Priorities change with
feedback, technical constraints, and whatever turns out to matter once people
are actually using the thing.

For implementation status, see the GitHub Project:
[Parley Roadmap](https://github.com/orgs/Lets-Parley/projects/1)

## Now

Work in progress or expected in the current development cycle.

### Spaces you can look after

A space used to be permanent the moment it existed: no rename, no delete, and a
typo in the name was a typo forever. Joining a room meant passing someone a link
and a passcode by hand, and a display name was set once at first sign-in.

Spaces and rooms can be renamed and deleted by the people who own them, a
profile is something you can edit, and an invite is one click rather than two
things copied into a chat window.

- Status: Merged, awaiting the next release
- Landed in [#274](https://github.com/lets-parley/parley/pull/274)

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

#### A meeting that ends

A session can be given a limit — a length, a number of stories — and when it
runs out the room says so and publishes what it did not get to. The unfinished
list is the artifact, and it is meant to be uncomfortable: a refinement backlog
written from evidence rather than from memory.

No tool that sells seats will ever ship this, which is reason enough.

- Status: Backlog

### Signed links

Some participation should be named but not account-bound. A person should be
able to vote on this story, add their standup update, or leave one piece of
context without first becoming a user the instance has to remember.

A signed link is a capability, not a login: it does one thing, for one room, and
expires. That makes it safer than "just make it public" and more honest than a
shared passcode that quietly becomes a second identity system.

- Status: Backlog
- Tracked in [#282](https://github.com/lets-parley/parley/issues/282)

### Take the whole instance with you

`parley export` writes every space, session, estimate, vote, and standup entry
to a single versioned archive, and `parley import` reconstitutes it on another
host. Data ownership is a claim until it is a file you are holding.

A database dump is not portability, it is coupling. This is also the backup
story for the many people whose backup story is currently nothing at all.
Export lands first and on its own — it is half the work and most of the trust.

- Status: Backlog

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

### Azure Marketplace

An Azure Marketplace Container offer, BYOL. This is a distribution channel for
teams that already want to run Parley themselves, but want procurement and
deployment to look like the rest of their Azure estate.

This is a customer-tenant install via Helm/CNAB. They run the container in their
own subscription, under their own policies. That is not Hosted / Cloud Parley:
Cloud is us operating the instance; Marketplace is them installing it.

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

### v0.6.1

- Thirty pre-rendered voxel-art portraits replace the maritime silhouettes at
  every size — CC0, no runtime dependency, no motion. The old avatar ids retire
  with them, so existing users pick again
- A portrait picker built on a native radio group, so keyboard reach, focus ring
  and announced selection come from the platform
- A committed light/dark contact sheet and a `portraits.sha256` byte pin, so a
  future lossy edit fails CI instead of shipping quietly
- v0.6.0 was tagged before the release pipeline's skopeo digest fix and never
  published; the same contents ship here

### v0.5.0 — Daybreak

- The poker round reads as a table someone sits down at, with a waiting count
  the whole room can see and the agreed estimate in its own colour
- The standup room is a room rather than a form with a timer in the corner: it
  says where the round is, how long is left, and who is ready
- Any standup entry can be re-read, and a standup can be ended
- A space counts who is actually in a session instead of calling it live
- Visible focus rings, errors reported beside the control that raised them

### v0.4.1 – v0.4.4

- Parley runs on more than one replica: presence, session fanout and the
  passcode throttle all moved into Postgres
- Hardened websocket sessions, network boundaries, and the release supply chain
- A field report from the first self-hosted deployment, answered: the published
  image stamps its real version, the chart accepts the public OIDC client the
  docs recommend, and `trustedProxyCIDRs` refuses a default route
- Reading a space no longer writes on every GET, and racing landing paths no
  longer create two spaces for the same visitor
- v0.4.0 and v0.4.3 were tagged but never published — a failed SBOM step and a
  stale skopeo digest respectively. Nothing shipped under either number; go from
  v0.3.0 to v0.4.1, and from v0.4.2 to v0.4.4

### v0.3.0

- `/version` on the instance, unauthenticated and independent of the database,
  so a rollout can be checked while Postgres is down
- A room everyone can actually use: every seat state and the revealed result
  carry a text equivalent, the standup rail says whose turn it is out loud, the
  member card sits on a native `<dialog>`, and the light theme clears WCAG AA
- Session kinds became a table with a foreign key instead of a `CHECK`
  constraint, routed through a client-side registry

### v0.2.1 – v0.2.3

- A broadcast to a closed connection no longer takes the server down with it —
  v0.2.2 is the release to be on if you are still on 0.2.1 or earlier
- The Helm chart is published to the registry

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
- Passcodes, with per-address throttling on wrong guesses
- CSV export
- A documentation site at [letsparley.io](https://www.letsparley.io)

## Feature requests

Have an idea? [Open an issue](https://github.com/lets-parley/parley/issues/new).

Being discussed here does not mean a feature has been accepted for
implementation — the Status field above is the honest signal.
