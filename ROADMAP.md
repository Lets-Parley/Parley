# Roadmap

This roadmap outlines the current direction of Parley.

It is not a guarantee of delivery dates or scope. Priorities change with
feedback, technical constraints, and whatever turns out to matter once people
are actually using the thing.

For implementation status, see the GitHub Project:
[Parley Roadmap](https://github.com/orgs/Lets-Parley/projects/1)

## Now

Work in progress or expected in the current development cycle.

### Kudos, with no leaderboard

A short note thanking somebody, attached to a person and visible to the team —
on the space itself, and as the closing beat of a standup, where a team has just
heard what everybody did and is most likely to mean it.

The interesting part is the constraint. The moment kudos are counted and ranked
they become a performance metric and the honest ones stop, so there is no count
column, no aggregate endpoint, and nothing that orders people by anything. That
is written into the schema rather than left to a UI decision.

A sender can withdraw a kudo; nobody can edit one. Guests neither send nor
receive: a signed-link guest is deliberately not somebody the instance
remembers, so a thank-you addressed to one would point at nobody by morning.

- Status: On Deck
- Tracking: [#386](https://github.com/lets-parley/parley/issues/386)

## Next

Accepted work, likely to be picked up after current priorities.

### Honest ceremonies

Two changes that make ceremonies tell the truth without turning facilitation
into a scoreboard.

#### Yesterday's promise

Standup already carries what you said you would do today into tomorrow's
"yesterday". It then asks nothing about it. A day's work is never falsified, so
a stuck item can quietly stay stuck for a fortnight while every individual
morning feels fine.

A commitment is a line you add beside the narrative. It carries into the next
session and opens with one question: did that land? Two sessions running without
landing, and the commitment is flagged as stuck — the commitment, not the
person, which is why it is a thing with its own identity rather than a mark
against a name. No streaks, no percentages, nothing that turns a facilitation
aid into a performance record.

- Status: Backlog
- Tracking: [#479](https://github.com/lets-parley/parley/issues/479)

#### A meeting that ends

A session can be given a limit, and when it runs out the room says so and
publishes what it did not get to. The unfinished list is the artifact, and it is
meant to be uncomfortable: a refinement backlog written from evidence rather
than from memory.

No tool that sells seats will ever ship this, which is reason enough.

The limit itself is not scoped yet: there is no session clock, no way to
broadcast a purely time-based event, and no facilitator control for it in
standup. The half that needs none of those — a poker session listing the stories
it never reached — is separated out and ready to build.

- Status: Backlog
- Tracking: [#482](https://github.com/lets-parley/parley/issues/482) for the
  poker half; the limit is unscoped

### Take the whole instance with you

`parley export` writes every space, session, estimate, vote, and standup entry
to a single versioned archive, and `parley import` reconstitutes it on another
host. Data ownership is a claim until it is a file you are holding.

A database dump is not portability, it is coupling. This is also the backup
story for the many people whose backup story is currently nothing at all.
Export lands first and on its own — it is half the work and most of the trust.

- Status: Backlog

### The estimate lands on the ticket

A poker story can carry a Jira issue key, and the agreed estimate writes to the
story point field when it is saved. That is the whole of the first slice.

The wide version — importing a board, syncing status, filing issues from the
room — is what the tools in this space already shipped, and it is also what
their users still complain about. Breadth is not the gap. One write path that
always works is. The same job for GitHub does not start until this one is
boring.

- Status: Backlog
- Tracking: [#391](https://github.com/lets-parley/parley/issues/391), under [#378](https://github.com/lets-parley/parley/issues/378)


## Later

Accepted direction, not currently scheduled.

### A plugin system

Extend Parley without forking it — integrations, AI features, meeting notes,
themes, and whole ceremonies, installed by the operator and running under
capability grants they approve. Plugin code is sandboxed WebAssembly with no
sockets and no database access; everything it reaches goes through a host
function that checks the grant first.

The extensible core shipped ([#8](https://github.com/lets-parley/parley/issues/8));
this is the layer on top of it.

- Status: Backlog
- Tracking: [#9](https://github.com/lets-parley/parley/issues/9)

### A parking lot with an owner and a clock

"Let's take that offline" is the most-spoken and least-honoured sentence in any
ceremony. A first-class parking lot refuses to accept the deferral without a
person and a date attached, then puts the item back in front of the room at the
next session until somebody deals with it.

This is the first thing Parley would store that belongs to a team rather than to
a single session, which makes it a fair test of whether the extension boundary
drawn by the extensible core is in the right place.

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
this follows the plugin and storage-boundary work rather than racing it. Both
backends would have to run the whole test suite in CI, or the two dialects drift
and the less-used one quietly rots.

- Status: Backlog

### The rest of the ceremonies

Retrospectives with grouping and dot voting, action items that outlive the
meeting, user story mapping, a sprint board, async standups, team health checks.
The meetings a delivery team already runs, in the tool they already have open.

Some of these will arrive as plugins rather than core features, which is rather
the point of the plugin system above.

Several of the Exploring ideas below — issue sync, chat integrations, meeting
recaps — are likely to become plugins once that system exists.

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
- The rest of two-way issue sync — importing a board, syncing status, filing
  from the room — beyond the write-back now under Next
  ([#378](https://github.com/lets-parley/parley/issues/378)); the same job for GitHub, once Jira works
  ([#383](https://github.com/lets-parley/parley/issues/383)); Linear to follow
- Replaying how a board or a ceremony actually evolved
- Spaces a creator can open to anyone, no sign-in required, on an instance
  that otherwise requires an identity provider
- Vote with the work — estimate from the ticket itself, not a copied title
- Stance, not a number — confidence or risk alongside points
- A room that dies with the meeting — the session ends when the calendar event does
- Audit logging, retention policies, and SSO group-to-role mapping
- White-label theming, for anyone hosting Parley on someone else's behalf
- Configurable timers for poker and standup — as one control rather than a
  ceremony of its own ([#380](https://github.com/lets-parley/parley/issues/380))
- Feature flags, once there is a third ceremony to turn off; machinery in
  search of a problem while there are two ([#381](https://github.com/lets-parley/parley/issues/381))
- Slack: a card posted when a session ends. The bot that runs a standup in a
  thread is a fight with the bots, on the axis where Parley is weakest
  ([#382](https://github.com/lets-parley/parley/issues/382))
- Team health and mood over time — anonymity and minimum-n settled before
  anything is built, and no scoreboard ([#384](https://github.com/lets-parley/parley/issues/384))
- A shared board owned by a space. Deliberately not scheduled: the tools that
  ship one get asked for the work to live in the tracker instead
  ([#385](https://github.com/lets-parley/parley/issues/385))
- Reactions and comments on a standup entry or a story — cheap once the storage
  boundary exists, and worth little before it ([#387](https://github.com/lets-parley/parley/issues/387))
- Async standup: a window instead of a meeting. The live clock is the wedge,
  and this is the version with the clock taken out ([#388](https://github.com/lets-parley/parley/issues/388))

## Completed

### Unreleased

- A facilitator can hand the role to a named participant from the roster, in
  poker and in standup alike, instead of the role only moving by going quiet for
  a minute ([#392](https://github.com/lets-parley/parley/issues/392))

### v0.10.0

- Named breakpoints, touch-first controls with a 44px hit floor, safe-area
  insets, and CI guardrails so a grid change does not quietly undo mobile layout
  — poker and standup are usable from a phone for participants voting and taking
  a turn
- A facilitator can remove someone from a session; the removed person sees why
  and lands on a dedicated screen rather than a dead socket
- Thrown emoji pile onto a seat when someone joins, with motion that respects
  reduced-motion preferences

### v0.9.0

- A space can save its own card decks under Settings, and they sit beside the
  built-in four when a session is created. A session copies the cards, so
  editing or deleting a deck never changes a room that is already dealing them
- Open voting keeps a round open for everyone who has been in the room, not
  only whoever is connected right now, so a distributed team can estimate
  across timezones. It never reveals a round by itself
- Sitting out mid-round as a spectator ends the wait there and then once
  everyone else has already voted

### v0.8.0

- Organizations put a level above spaces: membership comes from the identity
  provider that already knows which team someone is on, space slugs are unique
  per organization instead of per instance, and a new starter can find their
  team's rooms in the org directory instead of waiting for a link and a passcode
- An organization admin gets custody without access — rename, archive, reassign
  and clean up any space, including private ones, without being able to read a
  vote, a standup entry or a note, and the documentation now says plainly what
  an admin can and cannot see
- Space URLs are org-scoped, with legacy `/s/<slug>` links redirected to their
  organization rather than broken
- Poker can reveal on its own once everyone has voted, if you want it to
- Character limits are counted in characters everywhere — names, titles, standup
  entries and OIDC display names no longer truncate on a multi-byte name
- The test suite checks the UI with axe-core, and clickable controls finally get
  a pointer cursor

### v0.7.3

- A space page is the table again: `/s/<slug>` opens on a one-line invite strip
  and the session list, and everything that changes the space — members and
  their roles, the passcode, the name, and deleting it — moves to an owner-only
  `/s/<slug>/settings`, with the irreversible thing fenced off at the bottom
- The roster is rendered once where it belongs, in the sidebar, instead of three
  times down the page, and member names are no longer squeezed by their own
  role chips

### v0.7.2

- Signing in no longer means pretending to make a space: the landing page has
  its own way in, and says which account it is listing spaces for, with the way
  back out

### v0.7.1

- A signed link is a capability, not a login: it opens one room, expires on its
  own, and its holder votes in poker and takes a turn in the standup round-robin
  without becoming a user the instance has to remember
- Facilitator controls stay with the facilitator, and a guest's identity is
  redacted from everyone else's roster
- Spaces and rooms can be renamed and deleted by the people who own them
- A display name is something you can edit, not a decision made once at first
  sign-in
- An invite is one click rather than a link and a passcode copied into a chat
  window by hand
- A unanimous reveal is celebrated at the table
- v0.7.0 was tagged before the release pipeline's skopeo digest was re-resolved
  and never published; the same contents ship here

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

- The extensible core finished ([#8](https://github.com/lets-parley/parley/issues/8)):
  one shared authorization path for every session kind, migration versions read
  from filename prefixes rather than array position, and an unknown kind that
  refuses instead of silently rendering the wrong room
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
  constraint, routed through instance-based server and client-side registries —
  the first half of the extensible core
  ([#8](https://github.com/lets-parley/parley/issues/8))

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
