# Plugins

Read the sections that match the change: the host, SDK, and ceremony contract; frames, the bridge, and consent; any session kind or redacted state builder; room actions; or `broadcastLocal`.

`broadcastLocal` lives in `internal/api`. Its home is still this file, because the rule is the plugin call-slot bound. The plugin UI's chi group is the same kind of split: the route is registered in the router, and the rule is the frame.

A host fetch change reads [#fetch](#fetch) together with [#grants](#grants) and [#consent](#consent). A foreign install reads [#install-org](#install-org) and [http.md#tenancy](http.md#tenancy). A core `StateFunc` or serializer edit reads [#kinds](#kinds) even when no plugin is installed.

<a id="delivery"></a>

## Plugin delivery is at-least-once

`internal/plugin` has two delivery paths, and they are not interchangeable. Core subscribers (`Bus.SubscribeCore`) are in-process and synchronous, so the state broadcast stays instant. Plugin subscribers go through the outbox and are at-least-once: any handler on that path must be idempotent. Do not put plugin delivery in the WebSocket hub. The hub stays a dumb fan-out. Claims in the outbox and the job queue take a lease as well as `for update skip locked`. The lock is released at commit, so without the lease a second worker re-delivers a row that is still marked pending.

<a id="mutation"></a>

## A new sandbox guard gets a mutation

Plugin sandbox guards are covered by mutation, not by a passing test. `scripts/guard-mutation.sh` is a CI leg: it breaks each guard in `internal/plugin`, `internal/api`, and `web/src` on purpose and fails if the test covering it stays green. `target <tree> [go|web]` switches which tree the mutations after it patch. The web mutations are gated on `tsc -b` rather than a Go build. If you add a guard, add its mutation. If you move the line a mutation anchors on, the leg fails with `MUTATION SETUP FAILED` rather than passing quietly. Several guards are enforced at two sites on purpose (the call timeout and the memory cap are set both on the wazero runtime and in the Extism manifest). Mutate every site at once, or the leg reports a survivor that is really the second site holding.

<a id="frame"></a>

## `/plugin-ui` is its own chi group

The plugin UI frame's header carve-out is a chi route group, never a path check. `securityHeaders` sets `X-Frame-Options: DENY` for the whole instance, and a framed document that carries it is blocked before its CSP is read. `/plugin-ui/…` is registered in its own group, which never runs that middleware. Do not fold this into a prefix check inside `securityHeaders`: a prefix check is a matching rule, and matching rules get evaded. `TestEveryNonPluginRouteStillSendsXFrameOptionsDeny` walks the real routing tree, so a route that drifts into the group goes red.

<a id="projection"></a>

## A plugin frame receives only what `redactSession` builds

Nothing reaches a plugin frame that `redactSession` did not build. It is a projection, not a filter: it builds a view only for a room the framed install itself provides (`providesRoom`) and returns null for every other room, so a poker, standup, or other plugin's room has no path into the frame. That is the promise `internal/plugin/describe.go` makes at consent ([#consent](#consent)). Do not rewrite it as "copy the envelope, then delete what is hidden." A field the projection never writes cannot be forgotten, and a field a filter does not know about is shipped.

<a id="grants"></a>

## Capability grants are read on every host call

Plugin capability grants are checked inside the host function, never at load time and never against the bundle. `Store.State` is read on every call so a revoked grant stops working on the next call rather than the next restart. Do not add a cache in front of it without a way to invalidate it, and never read capabilities from anything the plugin author writes. The sentences an operator consents to are [#consent](#consent).

<a id="fetch"></a>

## The fetch guard dials the address it screened

The plugin fetch guard resolves once, screens every record, and dials the address it screened, for every redirect hop. Do not replace it with an `http.Client` that uses `CheckRedirect`. Following redirects with the standard client re-resolves the hostname and re-checks nothing, which is the DNS-rebinding hole the guard exists to close. Grant checks on that call are [#grants](#grants); the allowlist sentences on the consent screen are [#consent](#consent).

<a id="consent"></a>

## Consent wording is the plugin boundary

The consent screen's wording is part of the plugin boundary. Every sentence a grant is described by lives in `internal/plugin/describe.go`, beside the guard that enforces it, and a fetch allowlist entry is expanded into worked examples generated from `hostAllowed` itself. Do not write capability copy in `web/`. A screen that composes its own sentences will drift from the rule the host applies, and an operator will be consenting to something else. `TestExplanationsMatchTheGuard` and the `guard-mutation.sh` leg that breaks the expansion hold that line ([#mutation](#mutation)). Approval of a widening upgrade is never a default, autofocused, or single-keystroke action. Installing always carries an explicit `grantsAccepted`, which the server refuses to act without.

<a id="uninstall"></a>

## `Uninstall` is not `Disable`

`Admin.Uninstall` cascades to a plugin's key-value store and its encrypted secrets, which are unrecoverable, so it stays a distinct function. It is refused while any session of a kind the plugin provides still exists. Never route a disable through it, and never delete a `session_kinds` row to get past the refusal — the sessions naming that kind are the reason the refusal exists. The refusal check, the retirement of the kinds it provided, the delete, and the audit row are one transaction. Do not split them into separate round trips, and do not move the audit row onto the best-effort path the reversible actions use.

<a id="install-org"></a>

## A plugin install belongs to an org

A plugin install belongs to an org, and the admin gate does not enforce that. `requireOrgAdmin` resolves the `{org}` in the caller's own path, so it proves only that they administer an org — never that they administer the one owning the id in the URL. Reach installs through `plugin.Store.InOrg(orgID)`. Do not call `Store` methods directly, and do not use a bare `select … from plugin_installs where id = $1`. The `Store`'s own unscoped methods exist for the host, which is acting on a plugin it is already running rather than on an id somebody typed. A foreign install answers 404. A 403 confirms the id exists, which is enough to enumerate what other tenants run. `TestOneOrgsAdminCannotTouchAnothersPlugin` and the `guard-mutation.sh` entry that strips the `org_id` filter from all three sites hold that line. The same rule applies to anything else that becomes per-org: an id in a URL is scoped by the request's org, or it is not scoped at all. Pair this with [http.md#tenancy](http.md#tenancy).

<a id="kinds"></a>

## Session kinds are copy-on-write, and state is a client-safe projection

Core kinds are registered into a `session.Registry` in `api.Router`, each built by its package's `Kind()` constructor (`poker.Kind()`, `standup.Kind()`). Enabling a plugin install registers the kinds it provides, and disabling or uninstalling one unregisters them, so the registry is no longer written only at wiring time. `session.Registry` is copy-on-write behind an atomic pointer. Read it with `read()`. Do not index the map directly, and do not add a write path that mutates the live map instead of publishing a copy.

A kind's `OrgID` is empty only for the core kinds, which are instance-wide. A plugin-provided kind carries the installing org. The create path is `KnownInOrg`. `Known` stays org-blind on purpose: a room outlives the install that offered its kind, and loading one must not depend on whether a new one could be created.

Kind configs decode with `DisallowUnknownFields`. A `StateFunc` must return only redacted, client-safe data. That payload is broadcast to every participant. The rule applies to core kinds and to plugin kinds. `Host.Sessions` reads a room through the same envelope the browser is sent, so the kind's own `StateFunc` is the only thing deciding what a plugin may see. Do not build a plugin's view of a room out of store rows.

The checklist for adding a core kind — register it, seed its `session_kinds` row in a new migration, add its `KindDef` to `web/src/lib/kinds.ts` — is [Adding a session kind](../../site/src/content/docs/project/contributing.mdx#adding-a-session-kind). A plugin-provided kind is not that edit. It is not a `KindDef` in `web/src/lib/kinds.ts`. How a ceremony stays off the core tree is [Ceremonies delivered as plugins](../../site/src/content/docs/project/contributing.mdx#ceremonies-delivered-as-plugins) and [#core-untouched](#core-untouched).

<a id="core-untouched"></a>

## A plugin pull request does not touch the core

A ceremony delivered as a plugin may not bring a core commit with it. `scripts/check-core-untouched.sh` fails a pull request that touches `plugins/` and also touches `internal/`, `cmd/`, or `web/src`. The rule is one-directional: ordinary core work is untouched by it. What it tests is the claim the plugin system rests on, that the extension points are enough. If a plugin needs the host to change, that is a finding about the extension points and lands as its own pull request first. It is never folded into the plugin's. Do not widen the allowed set to get a branch green. The frontend is in the set on purpose: a ceremony that can only be rendered by editing `web/src/lib/kinds.ts` has been merged into Parley, not extended onto it. The public procedure is [Ceremonies delivered as plugins](../../site/src/content/docs/project/contributing.mdx#ceremonies-delivered-as-plugins).

<a id="refusal"></a>

## A refused action is not a plugin failure

A plugin refusing an action is not a plugin failing, and nobody in a room can get an install switched off. `on_session_action` answers `{"refused":"<code>"}` to decline. `actionRefusal` in `internal/plugin/kinds.go` reads it, and only output carrying that exact key is inspected, because output was ignored before and old guests must keep working. Anyone in a room — a link guest included — can send an action, so `Host.record` does not charge an action the guest itself reported as failed (`ErrGuestReported`: it ran to its end, in no more than half its call timeout). An action that had to be stopped is counted in `breaker.actionFailures`, which opens the cooldown and never trips. Do not merge that counter back into `failures`.

<a id="action-order"></a>

## Room actions line up, then take a slot, then take the lock

A room's actions run one at a time, in two stages, and the order of the stages is the capacity bound. `Host.callAction` lines a room's actions up in-process first (`enterRoom`, holding nothing), so one room has at most one call in flight and one connection parked per replica. Only then does `call` wait for the in-flight slot (`acquireBy`: actions and state builds wait, oldest first; events and jobs are still refused at once). State builds must stay in that line. `release` hands a freed slot straight to the oldest waiter, so a call that does not wait finds none while any action is queued, and the broadcast after every action fails silently.

With the slot held, `call` takes `lockRoom`'s advisory lock. That lock is the two-key form, class `actionLockClass`, and it is a different class from `migrationLockID` ([ship.md#replicas](ship.md#replicas)). It holds a pooled connection for the whole guest call. Taking the lock before the in-flight slot, or before the in-process line, lets one room or one install park the pool. `lockReserve` keeps the last two connections free for the guest's own key-value calls. The lock is released by `defer` before the broadcast. Do not hold it across one.

<a id="module"></a>

## A cached module is `unuse`d, not closed under a call

A compiled plugin module is never closed under a call. `Host.module` hands out a held `cachedModule`, and the caller must `unuse` it. Eviction and replacement only `retire` it, and the last `unuse` closes it. Compiles are single-flight per install (`Host.compiles`). Calling `Close` on a cached module directly, or compiling outside that mutex, brings back `module closed` failures on concurrent first calls, and those failures are charged to the breaker.

<a id="broadcast"></a>

## `broadcastLocal` holds the room mutex across build and send

A room's broadcasts are built and sent one at a time, and a broadcast may be skipped. `broadcastLocal` (`internal/api/sessions.go`) holds a per-room mutex across the build and the send, so the last frame sent is the newest state. It returns without building when a broadcast that began after it was asked for has already been sent. Do not move the send outside that mutex, and do not remove the skip: a state build per change is what exhausted the plugin call slots in an ordinary room.
