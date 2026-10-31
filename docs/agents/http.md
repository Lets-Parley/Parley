# HTTP

Read the sections that match the change: routes, identity, org and space SQL, signed links, custody, hub and presence, URL construction, and request IDs.

A new route is classified in the same change for CSRF ([#csrf](#csrf)), for signed-link guests and embedded sessions ([#route-class](#route-class)), and for tenancy ([#tenancy](#tenancy), and [#org-param](#org-param) when the route sits under `/api/orgs/{org}/`). Owning those rules in one file does not mean a later edit read them.

Adding a session kind is not a section here. The three-step checklist stays on the public contributing page. The runtime half — copy-on-write registry, `KnownInOrg` versus `Known`, client-safe `StateFunc`, `DisallowUnknownFields` — is [plugins.md#kinds](plugins.md#kinds).

<a id="csrf"></a>

## CSRF middleware is mounted on `/api` only

`rejectCrossSite` and `requireJSONBody` are registered inside `r.Route("/api", ...)` (`internal/api/router.go`). A new top-level route gets neither. `/auth` sits outside on purpose: identity-provider redirects are browser navigations, and that flow carries its own CSRF defense in the sign-in cookie's state value. A new route group states its own CSRF story.

<a id="link-fk"></a>

## `users.link_id` is `ON DELETE SET NULL`

`votes`, `standup_entries`, and presence all cascade from `users`. Cascading a signed link's delete into its holders would erase their votes and updates from a finished meeting and from any CSV exported afterwards. Link rows are not swept. A link expires on its own `expires_at`. It is not garbage-collected.

<a id="route-class"></a>

## Every new route is classified for link guests and embedded sessions

A redeemed link is a principal with no space membership. It reaches any route that does not sit behind `RequireUser` or `requireSpaceOwner`. `TestLinkGuestRouteTable` (`internal/api/link_routes_test.go`) walks chi's registered routes and fails on any pattern it does not already classify. Adding a route means deciding in that table what a link guest gets. The rule: participate actions and reading the bound room; everything else answers 401, 403, or 404. Reject a route with the `rejectLinkPrincipal` middleware, and put a second lock in the statement itself for anything that would escalate (see `store.ClaimFacilitator`).

A new route is also classified for an embedded (meeting-client) session in `embeddedRouteTable` (`internal/api/embed_routes_test.go`). It is refused 403 unless it is added to the allow-list `embeddedRoutes` in `internal/api/embed.go`, which is the only place that decision is made.

<a id="link-expiry"></a>

## A signed link's expiry lives on the session token it mints

Expiry is `session_tokens.expires_at`, never a timer or a sweeper. `hub.validate` already re-reads token validity on a ticker, so that column is the whole of mid-session severance. `ResolveToken` and `TokenExpiry` must both honor it. One of them skipping it leaves a lapsed link either answering requests or holding a socket.

<a id="hub"></a>

## Hub callbacks and the attach order

Every hub callback that reaches the database from its own goroutine goes through `hub.track`. Presence is recorded before the initial frame is released.

`Hub.Shutdown` waits on a `WaitGroup` covering `OnDisconnect`, `OnPresenceChange`, `OnFacilitatorSeen`, and the validation goroutines, because the caller closes the pgx pool the instant it returns. A `go h.Whatever(...)` added outside `track` shows up as `closed pool` errors in an unrelated test.

A callback invoked synchronously on a goroutine the hub already owns needs no `track`. The attach-time `OnFacilitatorSeen` is one of these: `AttachAuthenticated` must not return until it has run. It calls `confirmMembership`, then `OnFacilitatorSeen`, then `releaseInitial`, in that order. The re-check comes first because a connection it rejects must leave no presence row behind for another client's roster. Presence still comes before the frame, so a client holding its first state frame may assume its own presence row exists. `Envelope.RedactForGuest` filters participants to presence ∪ facilitator, so reordering those two turns every guest-visibility assertion into a coin flip.

A registered connection is not a broadcast recipient until that first frame has been delivered. Broadcasts carry one shared guest payload redacted with no self id, so one fired inside that window would tell a link guest it is not in its own room. Dropping those frames loses nothing, because the initial frame lands after them and would have overwritten them.

<a id="slug"></a>

## A space slug is unique inside an org

A space slug is unique inside an org, not across the instance, and every space lookup carries an org. `Spaces.Create` and `Spaces.BySlug` take an org id (`internal/store/spaces.go`).

Protected handlers behind `requireOrgMember` pass `orgFrom(ctx).ID` into `BySlug`. Anonymous pre-join routes cannot sit behind that middleware: `handleGetSpace` and `handleMintInviteHandle` use `Spaces.BySlugInOrg`, with the org slug from the URL in the same query ([#one-query](#one-query)). `GET /s/{slug}` searches only the caller's own memberships ([#legacy-slug](#legacy-slug)).

`app.org` resolves the default org lazily and caches it, because `Router` must not require a reachable database to hand back a handler. `app.orgID` is that helper's id. Callers are open-mode enrollment, the configured bootstrap admin, and — through `resolveOrg` — creating a space when the body names no org. A slug lookup does not go through it.

`spaces.org_id` is `on delete restrict`, because cascading from `orgs` would erase a tenant's whole history. The column still has a default of the default org, left from the rolling upgrade that added orgs so a replica on the previous binary could insert. New inserts name the org in `Spaces.Create`. That default is not how a request picks an org. `spaces.visibility` defaults to `'private'` so an upgrade discloses exactly what it did the day before. New spaces name their visibility in `Spaces.Create`. Open mode forces `'private'` on new spaces: it mints anonymous identities, and an org-visible space with no passcode would be a room any visitor could walk into.

<a id="link-users"></a>

## A backfill of every user excludes link guests

A backfill that says "every user" must exclude `users.link_id is not null`. A redeemed signed link mints an ordinary `users` row, but that row is a capability on one room rather than an account (`Principal.LinkSessionID`). Enrolling those rows in an org hands directory visibility to anyone ever sent a guest link. The mistake is invisible on any instance that has never issued one.

<a id="revocation"></a>

## `GrantMember` does not clear a revocation

Claim-derived membership never overrides a revocation tombstone. `Orgs.GrantMember` (`internal/store/orgs.go`) inserts and does nothing on conflict. `Orgs.AddMember` is the admin-driven counterpart that restores a revoked row and re-applies the role. Every sign-in re-grants from the claim, so a grant that cleared `revoked_at` would undo an admin's removal at the revoked person's next login. Sign-in mapping and open-mode enrollment both go through `GrantMember`.

<a id="org-param"></a>

## The org comes from `requireOrgMember`

Space routes are mounted under `/api/orgs/{org}/`. The org in a request comes from `requireOrgMember`, not from a second read of the chi parameter. `orgSlugFromRoute` (`internal/api/authz.go`) is the only reader of that URL segment. `orgFrom(ctx)` is how every handler behind the middleware gets the org, with an unchecked type assertion, so a handler mounted outside it panics rather than reading a zero uuid and skipping the tenancy check. `TestOrgParamHasOneReader` enforces this with go/types, so `chi.URLParamFromCtx` and `RouteContext().URLParam` are caught too.

<a id="tenancy"></a>

## Membership in an org is not proof the slug is in that org

Sitting behind `requireOrgMember` proves the caller is in org A. It says nothing about which org a space resolved by slug belongs to. `spaces.slug` is unique per org, so every lookup behind the middleware also filters by `orgFrom(ctx).ID`. A foreign slug is 404. `TestSpaceRoutesResolveWithinTheDefaultOrg` puts an identically slugged space in a second org and asserts 404 per route.

The same shape applies to a plugin install id: an admin of org A is not an admin of the install's org. A foreign install is 404. See [plugins.md#install-org](plugins.md#install-org).

<a id="one-query"></a>

## The anonymous space landing stays one query

`GET /api/orgs/{org}/spaces/{slug}` must stay one query. It is the anonymous link landing, so a bad org, a space in another org, and a slug that exists nowhere have to fail after identical work — hence `Spaces.BySlugInOrg`. Resolving the org first and the space second is a cross-org existence oracle even when the response bodies match.

<a id="no-org-prefix"></a>

## The session tree and link redeem stay free of an org prefix

The session tree and `POST /api/links/redeem` never acquire an org prefix. A link guest belongs to no org and no space, so it has no org slug for a URL and no membership to derive one from. Prefixing either would break every signed link ever issued. `TestEveryRouteIsScopeClassified` fails the build on any route that is not explicitly classified.

<a id="paths"></a>

## Space URLs in `web/src` come from `lib/paths.ts`

SPA routes, API calls, the copied invite, and the rename toast's prose all build from `spacePath`, `spaceSettingsPath`, and `spaceApi`. A slug alone is not an address, and the one site written out by hand is the one that 404s. `renderApp` takes a `path` so `useParams` resolves in tests.

<a id="legacy-slug"></a>

## `GET /s/{slug}` searches only the caller's orgs

`GET /s/{slug}` resolves only against the caller's own org memberships. It is the shim that keeps links shared before space URLs carried an org. It must never do a global slug lookup: that would answer differently for a slug held in an org the caller is outside than for one that exists nowhere. Zero matches and more than one both answer 404. Guessing between two of the caller's orgs would drop them in the wrong tenant's room. Anonymous callers and link guests fall through to the SPA. The redirect is 302, because a membership can be revoked.

<a id="visibility"></a>

## Visibility decides listing; the passcode decides entry

`spaces.visibility` decides whether a space is listed to its org by `GET /api/orgs/{org}/spaces`. The passcode still decides who is let in, and `handleJoinSpace` compares it the same way whatever the visibility. `PATCH .../visibility` must never write the passcode, and `POST .../passcode` must never write the visibility. "Listed but locked" is a real state, and neither route may strip the other column.

Two refusals hold the boundary. Open mode is refused `org` visibility before the store call, so the PATCH cannot route around the guard in `handleCreateSpace`. The directory is mounted inside `RequireUser` and then `requireOrgMember`, in that order, so a link guest is refused 401 at the first of them. If the directory ever answered for a link guest, one link to one standup would list every org-visible space on the instance.

<a id="custody"></a>

## Org custody is management without access

Four things enforce it.

(a) Custody handlers live in `internal/api/custody`, which imports neither the session, presence, and hub packages nor `internal/store`. A `go list -deps` test fails the build if that changes, and the two duplicated constant blocks are the deliberate price.

(b) They answer with `CustodySpace` and nothing else. A test reads the response as raw JSON and rejects any key outside the allow-list, because reflecting over the struct would not catch a handler marshaling an untyped map.

(c) Custody may only make a space more private. `private` → `org` is 403 there and stays the space owner's alone. An admin who widened a private space could join it as an ordinary org member and have everything by a different door.

(d) Ownership is granted, never transferred — an existing member only, never the admin themself, and never demoting an incumbent.

<a id="revoke"></a>

## Revoking an org member must not strand a space

The last-owner guard in `store.Spaces.mutateMembership` runs one space at a time, so the cross-space delete in `custody.Store.RevokeOrgMember` does the same job itself. Where the revoked person was sole owner, promote the most recently active remaining member (0015's rule: `last_seen_at`, then `user_id`). Where there is nobody to promote, refuse the whole revoke and write nothing. The tombstone is an upsert, never an update: somebody with no `org_members` row yet must still be revocable before their first sign-in.

<a id="audit-fk"></a>

## `org_audit_log` foreign keys are `ON DELETE SET NULL`

Both foreign keys are `on delete set null`, and both slugs are stored as text, so a record outlives the space and the org it names. The org purge deletes exactly those things. A cascade would erase the record of the action most worth recording.

<a id="purge"></a>

## Org purge is one transaction

The counts are read inside that transaction. `spaces.org_id` is `on delete restrict`, so spaces go before the org row. An interrupted purge must leave everything standing rather than some spaces gone, the rest not, and the org row undeletable. It refuses without the org's own slug as `confirm`, and it refuses the default org outright.

<a id="request-id"></a>

## `X-Request-Id` is honored only from a trusted TCP peer

An inbound `X-Request-Id` is honored only from a socket peer in `TrustedProxyCIDRs`. `acceptTrustedRequestID` runs before `trustedProxyHeaders` rewrites `RemoteAddr`, so the peer checked is the TCP peer, not the forwarded client. Do not move it after the rewrite, and do not treat `TrustProxyHeaders` as sufficient on its own ([ship.md#proxy](ship.md#proxy)). Cap the value at 128 printable ASCII characters so a hostile header cannot inject a newline into logs. `echoRequestID` exists because chi's `middleware.RequestID` does not set the response header. Security-event lines are `logSecEvent` in `internal/api/secevent.go` (and the matching `slog` call in `internal/api/custody/store.go`). Do not log cookies, tokens, passcodes, or bodies onto that line.
