# Roadmap

Nothing here is promised, and the order will change. This is the shape of where
Parley could go, written down so the trade-offs are arguable in the open rather
than decided quietly.

Parley today is planning poker and a daily standup: one Go binary, one Postgres
database, no accounts. The destination sketched below is a collaboration surface
for a delivery team — every agile ceremony, on a real whiteboard, self-hosted.

Effort is one person's rough guess, not a commitment:

| Key | Roughly |
|---|---|
| `S` | days |
| `M` | one to two weeks |
| `L` | three to six weeks |
| `XL` | a quarter or more |

## Phase 0 — Foundations

Groundwork that everything after it depends on. Two current invariants — the
in-process hub with its single-instance advisory lock, and the two-value CHECK
constraint on `sessions.kind` — have to give first.

| Feature | What it is | Effort |
|---|---|---|
| Pluggable session kinds | Drop the `sessions.kind` CHECK for a registry-backed enum, so a new ceremony is code rather than a migration (`internal/session/registry.go`) | S |
| Multi-replica realtime | Postgres `LISTEN`/`NOTIFY` fan-out behind `internal/hub/hub.go`, retiring the single-instance lock in `cmd/parley/main.go` | L |
| Space membership roles | Owner, facilitator, member, spectator — replacing "any member can do anything" (`internal/api/authz.go`) | M |
| Account linking | Merge an anonymous user into a federated identity on first sign-in, so turning OIDC on doesn't leave history behind | M |
| Knock-to-join | Request access from the door and let a facilitator wave you in, instead of needing the room code | S |
| Export framework | Generalise `internal/session/csv.go` into a per-kind exporter: CSV, JSON, Markdown, PDF | M |
| Object storage | A blob abstraction (filesystem and S3) for uploads, thumbnails, and generated exports | M |

## Phase 1 — The ceremony suite

The rest of the meetings a delivery team already runs. Ships value fastest, and
needs almost nothing from Phase 2.

| Feature | What it is | Effort |
|---|---|---|
| Retrospective | A session kind with columns and cards, authorship hidden until reveal | L |
| Grouping and dot voting | Cluster related cards, spend N votes each, sort by score | M |
| Action items | Assignable, dated outcomes that outlive the session and reappear in the next one | M |
| Retro templates | Start/Stop/Continue, Mad-Sad-Glad, 4Ls, Sailboat, Starfish, and custom | S |
| User story mapping | Activity, step, and story across release swimlanes | L |
| Sprint board | Columns with WIP limits, drag between them, assignee and estimate per card | L |
| Async standup | Write your update on your own clock; a digest posts at a scheduled time | M |
| Icebreakers and check-ins | An opening prompt, a mood poll, a round-robin question | S |
| Team health check | Recurring dimensions scored as a radar, trended across sessions | M |
| Facilitator toolkit | Shared countdown, phase locking, order shuffle, an everyone-answers gate | S |
| Anonymous mode | A per-session toggle that hides authorship everywhere, not only before reveal | S |
| Session series | Link sessions so a ceremony carries its own context forward automatically | M |
| Cross-session analytics | Estimate accuracy, velocity, blocker frequency, action follow-through | M |

## Phase 2 — The whiteboard

The largest bet on this page, and the one worth deciding deliberately: a CRDT
document engine is infrastructure, not a feature. Everything below it is
comparatively small; the engine is the commitment.

Scope here is the collaborative core. A diagramming suite, third-party app
embeds, in-app video, and an enterprise admin console are explicitly out.

| Feature | What it is | Effort |
|---|---|---|
| Board document engine | A CRDT document per board, persisted to Postgres with snapshots | XL |
| Infinite canvas | Pan, zoom, viewport culling, minimap, zoom-to-fit | L |
| Sticky notes | Create, edit in place, recolour, resize, auto-pack into a grid | M |
| Shapes and text | Rectangle, ellipse, diamond, triangle, free text, and styling | M |
| Freehand ink | Pressure-aware strokes, highlighter, eraser | M |
| Connectors | Arrows anchored to objects that follow them, with routing and labels | L |
| Frames and sections | Named regions for grouping, presenting, and export boundaries | M |
| Cursors and selection | Live cursors with names, remote selection outlines, follow-the-presenter | M |
| Comments | Threads pinned to an object or a coordinate, with a resolved state | M |
| Board templates | Retro, story map, brainwriting, SWOT, journey — and save any board as one | M |
| Images and embeds | Paste or drag a file onto the canvas, stored via Phase 0 | M |
| Board export | PNG, SVG, and PDF of a board or a single frame, plus structured JSON | M |
| Board history | Snapshots, restore, and undo/redo that behaves with several people editing | L |
| Voting and timer on canvas | Dot voting on any object and a shared timer overlay | S |

## Phase 3 — Beyond parity

Where a self-hosted tool can do things a hosted one structurally cannot.

| Feature | What it is | Effort |
|---|---|---|
| Ceremony and canvas as one | Every ceremony is a board and every board can run a ceremony — a retro card and a sticky note are the same object | L |
| Local-first boards | The CRDT engine already allows it: work offline, merge on reconnect | L |
| Retro synthesis | Cluster cards, name the themes, draft the actions — bring your own model endpoint, so nothing leaves the instance | M |
| Assisted facilitation | Notice a stalled round, suggest the next phase, nudge the quiet, write the recap | M |
| Recaps and digests | A Markdown summary of any session, delivered by email, chat, or webhook | M |
| Estimation intelligence | Flag the spread that means hidden disagreement; suggest from similar past stories | M |
| Transcript to cards | Turn a meeting transcript into retro cards or action items, transcribed locally | L |
| Embeddable boards | A read-only board in an iframe, and an API that makes a board data other tools can drive | M |
| Integrations | Two-way issue sync with Jira, Linear, and GitHub; chat notifications; calendar-triggered ceremonies | L |
| Presenter mode | Walk an audience frame by frame, for review and demo | S |
| Timeline scrubber | Replay how a board or a ceremony actually evolved | M |
| Single-purpose links | A signed link that does one thing — vote on this story, add your standup — and needs no login | S |
| Governance | Audit log, retention policy, per-space export and erasure, SSO group to role mapping | M |
| White-label theming | A logo, a palette, and a domain, for anyone hosting Parley on someone else's behalf | S |

## Sequencing

These phases are ordered by dependency, not by value. Phase 1 is the fastest
path to a tool a team uses every day. Phase 2 is a fork in the road — Parley
either becomes a whiteboard or deliberately declines to, and the best of Phase 3
sits downstream of that answer.

Disagreement is useful here. If something below the line matters more to you
than something above it, open an issue and say so.
