#!/usr/bin/env bash
# Mutation testing for the plugin sandbox guards.
#
# A hostile fixture that passes proves nothing on its own: it also passes when
# the fixture never reached the guard, when the assertion is vacuous, and when
# the guard was deleted last week. This script breaks each guard on purpose and
# insists the test that covers it goes red. A guard whose test still passes
# while the guard is gone is not a test.
#
# It runs as its own CI leg rather than as a thing somebody remembers to do,
# because a one-time manual check is a check that happened once.
set -euo pipefail

cd "$(dirname "$0")/.."

# The guards no longer all live in one package: the plugin sandbox has a
# frontend half now, so a tree here is either a Go package or the web app, and
# `target` switches which one the mutations below are aimed at.
TREES=(internal/plugin internal/api web/src cmd/parley)
BACKUP=$(mktemp -d)
LOG=$(mktemp)

restore_all() {
    for tree in "${TREES[@]}"; do
        cp -a "$BACKUP/${tree//\//_}"/. "$tree"/ 2>/dev/null || true
    done
}
trap 'restore_all; rm -rf "$BACKUP" "$LOG"' EXIT
for tree in "${TREES[@]}"; do
    mkdir -p "$BACKUP/${tree//\//_}"
    cp -a "$tree"/. "$BACKUP/${tree//\//_}"/
done

PKG=./internal/plugin
SRC=internal/plugin
RUNNER=go

# target <tree> [go|web] — where the next mutations patch and how they are run.
target() {
    SRC=$1
    RUNNER=${2:-go}
    PKG=./$1
}

# Two different kinds of bad news, counted apart. `failures` is findings about
# the code: a guard was broken and its test stayed green. `harness_failures` is
# this script's own bookkeeping coming apart — a missing anchor, a baseline
# that was already red, a mutation that would not compile. Both exit 1, but
# reporting them under one number told an operator "you have N uncovered
# guards" when the truth was "this script cannot currently tell you anything".
failures=0
harness_failures=0
checked=0

patch_once() {
    python3 -c 'import sys
path, find, replace = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    body = fh.read()
with open(path, "w") as fh:
    fh.write(body.replace(find, replace, 1))' "$1" "$2" "$3"
}

# run_tests <spec> — runs the named test(s) in the current tree.
#
# For a Go tree <spec> is a -run regexp. For the web tree it is
# "<file>::<test name>": the file so the run is cheap, and the name so the
# harness can say *which* test caught a guard rather than "something in that
# file did". A file alone is not accepted — see web_spec_ok.
# --no-webstorage exists from Node 26 and is required there (its global
# localStorage shadows jsdom's); an older Node exits on the unknown option.
WEB_NODE_OPTIONS=""
if node --no-webstorage -e "" >/dev/null 2>&1; then
    WEB_NODE_OPTIONS="--no-webstorage"
fi

run_tests() {
    local spec=$1
    if [ "$RUNNER" = "web" ]; then
        # web/package.json's test script sets NODE_OPTIONS=--no-webstorage:
        # Node ships a global localStorage that shadows jsdom's, so without the
        # flag every web test dies on an undefined storage. But the flag only
        # exists from Node 26, and an older Node exits on an unknown option --
        # so the runner needs it and a developer box may refuse it. Probe once
        # rather than pick an environment to be correct in.
        # NO_COLOR: this harness reads vitest's summary line to tell a real
        # run from one that matched no test. A terminal-less local pipe is
        # already plain, but the runner gets colour, and the escapes land
        # between "Tests" and the count -- so the check silently stopped
        # matching in CI and every web guard reported as unscored.
        (cd web && NO_COLOR=1 NODE_OPTIONS=$WEB_NODE_OPTIONS \
            npx vitest run "${spec%%::*}" -t "${spec#*::}") >"$LOG" 2>&1
        return $?
    fi
    # -timeout keeps a mutation that removes a timeout from hanging the leg
    # forever; a hung run is still a red run, which is the answer we want.
    go test "$PKG" -run "$spec" -count=1 -timeout 120s >"$LOG" 2>&1
}

# web_spec_ok <name> <spec> — the target of a web guard must actually exist.
#
# vitest exits 1 when it matches no test file, and this harness reads a
# non-zero exit as "the mutation was caught". So renaming or deleting a guard's
# target file used to turn that guard silently green: the strongest-looking
# pass in the report was the one covering nothing at all. The Go branch never
# had the hole — `go test -run NoSuchTest` exits 0, which reads as SURVIVED —
# and this closes it on the web side, where the file is a path the harness can
# simply check for.
web_spec_ok() {
    local name=$1 spec=$2
    if [ "$spec" = "${spec%%::*}" ]; then
        echo "HARNESS FAILED: $name — a web guard must name a test: '<file>::<test name>', got '$spec'."
        return 1
    fi
    if [ ! -f "web/${spec%%::*}" ]; then
        echo "HARNESS FAILED: $name — its target file web/${spec%%::*} does not exist."
        echo "  A vanished target makes vitest exit 1, which this harness would otherwise score as 'caught'."
        return 1
    fi
    return 0
}

# baseline_ok <name> <spec> — the named test must pass BEFORE the mutation.
#
# Without this the harness cannot tell "the guard is covered" from "the test
# was renamed, deleted, or never ran". A test that is already red, or that
# matches nothing, would go on to be red after the mutation too, and every one
# of those is a green report over an uncovered guard. It runs against the
# pristine tree, so a failure here is a fault in the harness's own bookkeeping
# rather than a finding about the code.
baseline_ok() {
    local name=$1 spec=$2
    if ! run_tests "$spec"; then
        echo "HARNESS FAILED: $name — '$spec' does not pass before the mutation,"
        echo "  so its going red afterwards would say nothing about the guard."
        sed -n '1,40p' "$LOG"
        return 1
    fi
    # A run that matched no test is the same hole wearing a green exit code:
    # `go test -run NoSuchTest` exits 0 having run nothing at all, and vitest
    # exits 0 having skipped every test in the file when -t matches no name.
    # Both would then be "red" after the mutation for the same empty reason.
    if [ "$RUNNER" = "go" ] && grep -q "no tests to run" "$LOG"; then
        echo "HARNESS FAILED: $name — '$spec' matched no test in $PKG."
        return 1
    fi
    if [ "$RUNNER" = "web" ] && ! grep -qE "Tests +[1-9][0-9]* passed" "$LOG"; then
        echo "HARNESS FAILED: $name — '${spec#*::}' matched no test in web/${spec%%::*}."
        sed -n '1,20p' "$LOG"
        return 1
    fi
    return 0
}

# mutate <name> <test regexp> <file> <find> <replace> [<file> <find> <replace> ...]
#
# Several guards are enforced in more than one place on purpose. Breaking one
# site and finding the test still green would say the belt held while the
# braces were cut, not that the test is worthless — so those guards are broken
# at every site at once.
mutate() {
    local name=$1 tests=$2
    shift 2
    checked=$((checked + 1))
    cp -a "$BACKUP/${SRC//\//_}"/. "$SRC"/

    # Before anything is broken: the test this guard names has to exist and be
    # green. Everything below reads "went red" as "the guard is covered", and
    # that reading is only true of a test that was passing to begin with.
    if [ "$RUNNER" = "web" ] && ! web_spec_ok "$name" "$tests"; then
        harness_failures=$((harness_failures + 1))
        return
    fi
    if ! baseline_ok "$name" "$tests"; then
        harness_failures=$((harness_failures + 1))
        return
    fi

    while [ "$#" -ge 3 ]; do
        local file=$1 find=$2 replace=$3
        shift 3
        if ! grep -qF -- "$find" "$SRC/$file"; then
            echo "MUTATION SETUP FAILED: $name — this anchor is no longer in $file:"
            echo "  $find"
            harness_failures=$((harness_failures + 1))
            return
        fi
        patch_once "$SRC/$file" "$find" "$replace"
    done

    # A mutation that does not compile makes `go test` exit non-zero for a
    # build reason, and the check below would score that as "caught" no matter
    # what the named test asserts — the mutation would be vacuous and look
    # like the strongest kind of pass. So the package has to still build
    # before its test result means anything, and a mutation that breaks the
    # build is a failure of this harness rather than a caught guard.
    #
    # The gate builds the *test* binary rather than the package, because
    # `go build` does not compile _test.go files: a mutation that broke only a
    # test file built clean and was then scored "caught" for exactly the
    # vacuous reason this gate exists to catch. `go test -run XXNONEXX` matches
    # no test, so it compiles everything and runs nothing.
    #
    # `go vet` would type-check the test files too, and would be cheaper, but
    # it is a lint as well as a type-check: its `unreachable` analyzer fails
    # three of the mutations below, which return early on purpose. A gate that
    # says "did not compile" must mean it.
    if [ "$RUNNER" = "web" ]; then
        # vitest transpiles without type-checking, so a mutation that breaks
        # the types would still run and would still be scored. tsc is the
        # equivalent of the compile gate below.
        if ! (cd web && npx tsc -b) >"$LOG" 2>&1; then
            echo "MUTATION DID NOT COMPILE: $name — a build break is not a caught mutation."
            sed -n '1,40p' "$LOG"
            harness_failures=$((harness_failures + 1))
            return
        fi
    elif ! go test -run 'XXNONEXX' -count=1 "$PKG" >"$LOG" 2>&1; then
        echo "MUTATION DID NOT COMPILE: $name — a build break is not a caught mutation."
        sed -n '1,40p' "$LOG"
        harness_failures=$((harness_failures + 1))
        return
    fi

    if run_tests "$tests"; then
        echo "SURVIVED: $name — the guard was broken and '$tests' still passed."
        sed -n '1,40p' "$LOG"
        failures=$((failures + 1))
    else
        echo "caught:   $name — '$tests' went red with the guard broken."
    fi
}

mutate "the private-address screen" \
    'TestFetchRefusesPrivateLoopbackLinkLocalAndMetadataAddresses|TestFetchScreensEveryResolvedRecordNotOnlyTheFirst|TestAFetchToALinkLocalAddressIsBlockedInsideTheHostFunction' \
    fetch.go 'func blockedAddress(a netip.Addr) bool {' 'func blockedAddress(a netip.Addr) bool { return false //nolint
'

mutate "the per-hop allowlist recheck" \
    'TestEveryRedirectHopRepeatsTheWholeSequence|TestAFetchRedirectedToADisallowedHostIsBlockedOnTheHop' \
    fetch.go 'if !hostAllowed(u.Hostname(), allow) {' 'if hop == 0 && !hostAllowed(u.Hostname(), allow) {'

mutate "the per-hop scheme check" \
    'TestEveryRedirectHopRepeatsTheWholeSequence' \
    fetch.go 'if !strings.EqualFold(u.Scheme, "https") {' 'if hop == 0 && !strings.EqualFold(u.Scheme, "https") {'

mutate "the redirect budget" \
    'TestEveryRedirectHopRepeatsTheWholeSequence' \
    fetch.go 'if hop > f.redirects() {' 'if false {'

mutate "the synchronous-hook fetch ban" \
    'TestASynchronousHookCannotFetchThroughTheHostFunction' \
    hostfn.go 'if info.mode != ModeAsync {' 'if false {' \
    fetch.go 'if sync {' 'if false {'

mutate "the grant check" \
    'TestAnUngrantedCapabilityIsRefusedInsideTheHostFunction|TestAGrantRevokedMidLifeStopsWorkingOnTheNextCall|TestAForgedKeyCannotReachAnotherNamespace' \
    grants.go 'func (s State) Allows(capability, scope string) bool {' 'func (s State) Allows(capability, scope string) bool { return true //nolint
'

mutate "the key namespace separator check" \
    'TestAForgedKeyCannotReachAnotherNamespace' \
    hostfn.go 'if strings.Contains(key, kvSeparator) {' 'if false {'

mutate "the per-call timeout" \
    'TestAHangingPluginIsStoppedByTheCallTimeout' \
    host.go 'ctx, cancel := context.WithTimeout(ctx, h.cfg.CallTimeout)' 'ctx, cancel := context.WithTimeout(ctx, time.Hour)' \
    host.go 'Timeout: uint64(h.cfg.CallTimeout.Milliseconds()),' 'Timeout: uint64(time.Hour.Milliseconds()),'

mutate "the memory cap" \
    'TestAMemoryHungryPluginIsStoppedByTheMemoryCap' \
    host.go 'Memory:  &extism.ManifestMemory{MaxPages: h.cfg.MemoryPages},' '' \
    host.go 'RuntimeConfig: wazero.NewRuntimeConfig().WithMemoryLimitPages(h.cfg.MemoryPages).WithCloseOnContextDone(true),' 'RuntimeConfig: wazero.NewRuntimeConfig().WithCloseOnContextDone(true),'

mutate "the in-flight cap" \
    'TestInFlightCallsAreCappedPerInstallAndInTotal' \
    host.go 'if h.total >= h.cfg.MaxConcurrentCalls || h.inflight[installID] >= h.cfg.MaxConcurrentPerInstall {' 'if false {'

mutate "the circuit breaker" \
    'TestARepeatedlyFailingPluginIsDegradedAndThenDisabled' \
    breaker.go 'func (b *breaker) failure(now time.Time, cooldown time.Duration) breakerOutcome {' 'func (b *breaker) failure(now time.Time, cooldown time.Duration) breakerOutcome { return breakerHealthy //nolint
'

mutate "the compiled-module cache bound" \
    'TestTheCompiledModuleCacheIsBounded' \
    host.go 'for len(h.cache) > h.cfg.MaxCachedModules {' 'for false {'

mutate "the pending-upgrade hold" \
    'TestAnUpgradeAskingForMoreParksAndTheOldGrantsStayInForce' \
    grants.go 'if !current.Allows(g.Capability, g.Scope) {' 'if current.Allows(g.Capability, g.Scope) && false {'

# A capability refusal downgraded to a malformed-input error is a policy
# decision reported as a client bug: a guest retries a permanent denial
# forever, and an operator reading the log looks for the wrong fault. The
# sentinel, not just the fact of a refusal, is what the test has to pin.
mutate "the sentinel on a capability refusal" \
    'TestEveryCapabilityRefusalKeepsItsSentinel' \
    hostfn.go 'CapabilityKV, req.Scope, ErrNotGranted' 'CapabilityKV, req.Scope, ErrBadRequest'

mutate "the credential strip across a redirect to another host" \
    'TestCredentialsDoNotFollowARedirectToAnotherHost' \
    fetch.go 'if !sameHost && sensitiveHeaders[http.CanonicalHeaderKey(k)] {' 'if false {'

mutate "the module cache's version check" \
    'TestAnUpgradeIsRunFromTheNewBundleRatherThanTheCachedOne' \
    host.go 'if entry, ok := h.cache[installID]; ok && entry.version == state.Install.Version {' 'if entry, ok := h.cache[installID]; ok {'

mutate "the breaker's reset on success" \
    'TestASuccessBetweenTwoFailuresKeepsTheBreakerClosed' \
    breaker.go 'func (b *breaker) success() { b.failures = 0 }' 'func (b *breaker) success() {}'

# Uninstall destroys a plugin's key-value store and its unrecoverable encrypted
# secrets. The refusal while sessions of a provided kind exist is the only thing
# standing between an operator and rooms that name a kind nothing can run.
mutate "the uninstall block on sessions of a provided kind" \
    'TestUninstallIsRefusedWhileASessionOfAProvidedKindExists|TestAnEndedSessionStillBlocksAnUninstall' \
    health.go 'if len(blocking) > 0 {' 'if false {'

# The consent screen only means something if the sentence it shows and the rule
# the guard applies are the same rule. An expansion that stops matching
# hostAllowed is a screen inviting an operator to consent to something else.
mutate "the honesty of the fetch-allowlist expansion" \
    'TestExplanationsMatchTheGuard|TestAWildcardIsExpandedRatherThanEchoed' \
    describe.go 'out.Allows = []string{"api." + base, "a.b." + base}' 'out.Allows = []string{base}'

# An install belongs to an org, and the org gate in front of the operator
# routes only proves the caller administers *an* org. Scoping every lookup to
# the org the request resolved to is the whole of what stops one org's admin
# uninstalling another org's plugin — destroying its key-value store and its
# unrecoverable encrypted secrets. It is enforced at three sites, so all three
# are broken at once.
mutate "the per-org scoping of an install lookup" \
    'TestAnInstallOfAnotherOrgIsNotFound' \
    orgscope.go '`select id from plugin_installs where id = $1 and org_id = $2`, installID, a.orgID).Scan(&got)' '`select id from plugin_installs where id = $1`, installID).Scan(&got)' \
    grants.go '`update plugin_installs set enabled = $3 where id = $1 and org_id = $2`, installID, orgID, enabled)' '`update plugin_installs set enabled = $2 where id = $1`, installID, enabled)' \
    health.go '`delete from plugin_installs where id = $1 and org_id = $2`, installID, orgID)' '`delete from plugin_installs where id = $1`, installID)'

# A garbage cron stored as a pending job is a silent no-op: Claim waits on
# run_at, and a row that never becomes due looks successful to the guest.
mutate "invalid cron refused at schedule time" \
    'TestAnInvalidCronIsRefusedAndStoresNothing|TestParseCronRefusesGarbageRatherThanStoringASilentNoOp' \
    hostfn.go 'next, err := nextCron(req.Cron, runAt)' 'next, err := nextCron(req.Cron, runAt); err = nil' \
    cron.go 'if len(fields) != 5 {' 'if false && len(fields) != 5 {'

# ---------------------------------------------------------------------------
# The frontend half of the sandbox: the framed route's header carve-out, and
# the bridge that is the only thing a plugin's UI can reach.
# ---------------------------------------------------------------------------

# A disabled plugin's ceremony has to stop being offered at once. Without the
# retirement the registry keeps handing it out, and a room of a kind nothing
# can run is created against a plugin an operator has switched off.
mutate "retiring a disabled plugin's session kinds" \
    'TestEnablingAnInstallOffersItsKindAndDisablingRetiresIt' \
    host.go 'h.RetireKinds(defs)' '_ = defs'

# A kind name is instance-wide, so two orgs running plugins of the same name
# collide on it. Without the org half of the upsert predicate the second org's
# install silently takes over the first org's kind row — and with it every room
# already created against it.
mutate "the org half of the session-kind upsert predicate" \
    'TestTwoOrgsRunningTheSamePluginNameDoNotShareAKind' \
    kinds.go 'and session_kinds.org_id is not distinct from excluded.org_id' 'and true'

# The other half of the same predicate, and the one both org tests are blind
# to: they differ in provider as well, so either half alone refuses them. Drop
# the provider check and an install can take over a kind row its own org's
# other plugin provides — its display, its whole dispatch table, its retirement.
mutate "the provider half of the session-kind upsert predicate" \
    'TestAnInstallCannotTakeOverAKindItsOwnOrgAlreadyProvides' \
    kinds.go 'where session_kinds.provider = excluded.provider' 'where true'

# Two kinds in one manifest are the same kind when their names match. Keyed on
# the display name instead, the screen is still a screen — of the wrong field —
# and every other fixture in the tree stays green.
mutate "the field the duplicate-kind screen compares" \
    'TestDuplicateDetectionComparesTheKindNameAndNotTheDisplayName' \
    kinds.go 'if seen[def.Kind] {' 'if seen[def.Display] {' \
    kinds.go 'seen[def.Kind] = true' 'seen[def.Display] = true'

# And the same sentence one level down: an unscreened duplicate action name is
# a dispatch table with one of the two entries silently winning.
mutate "the duplicate-action-name screen" \
    'TestAKindDeclaringOneActionNameTwiceIsRefused' \
    kinds.go 'if names[a.Name] {' 'if false {'

# ProvidesKind is the ownership half of the plugin session surface's boundary.
# Without the retirement and the enabled flag it answers "yes" for a retired
# kind of a switched-off install, and the boundary is then leaning on the
# enabled check that happens to sit two layers up in hostfn.go.
mutate "the retirement and enabled filters on the kind-ownership answer" \
    'TestASwitchedOffInstallAndARetiredKindProvideNothing' \
    kinds.go 'where p.id = $1 and k.kind = $2 and k.retired_at is null and p.enabled)' 'where p.id = $1 and k.kind = $2)'

# A manifest's action verb is canonicalised and then screened against a closed
# set. Without the screen a manifest declaring anything at all installs, and the
# action it declares is either dead or reaches the dispatcher unscreened.
mutate "the closed set of verbs an action may answer" \
    'TestAManifestDeclaringAKindTheHostWillNotHonourIsRefusedAtInstall' \
    kinds.go 'if !actionVerbs[a.Verb] {' 'if false {'

target internal/api

mutate "the plugin frame's route-group carve-out" \
    'TestThePluginFrameIsNotDeniedByXFrameOptions' \
    router.go 'a.mountPluginFrame(root)
	r := root.With(securityHeaders)' 'r := root.With(securityHeaders)
	a.mountPluginFrame(r)'

# chi answers a known path with an unknown method from its own handler, outside
# the route tree — so a header middleware that moved from root.Use onto a route
# group stopped covering every 405 on the instance. Registering it through the
# group is what puts it back; registering it on root is the bug, and it
# compiles.
mutate "the security headers on a method-not-allowed response" \
    'TestSecurityHeadersOnAMethodNotAllowedResponse|TestEveryNonPluginRouteStillSendsTheSecurityHeaders' \
    router.go 'r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {' 'root.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {'

mutate "the framed document's connect-src 'none'" \
    'TestThePluginFrameIsNotDeniedByXFrameOptions' \
    pluginframe.go "connect-src 'none'; " "connect-src *; "

mutate "the framed document's frame-ancestors" \
    'TestThePluginFrameIsNotDeniedByXFrameOptions' \
    pluginframe.go "frame-ancestors 'self'; " "frame-ancestors *; "

mutate "the script-close-tag escape in the frame document" \
    'TestAScriptCloseTagInAUIBundleCannotBreakOutOfTheFrameScript' \
    pluginframe.go 'return strings.NewReplacer("</", `<\/`, "<!--", `<\!--`).Replace(js)' 'return js //nolint
'

# A sibling plugin's frame can postMessage to this one. Whoever answers the
# handshake first supplies the port, so without a sender screen plugin A hands
# plugin B a channel A controls — forged state in, B's action proposals out.
# The condition is not the guard — returning is. An earlier version of this
# mutation deleted the whole `if`, which the text-shaped test it named caught
# for the wrong reason; emptying the bodies instead leaves both conditions
# present and in order and makes the screen a no-op, which only a test that
# runs the bootstrap can see. It runs from the web tree because that test is
# vitest: the guard is a .js file the Go package embeds and jsdom executes.
target internal/api web

mutate "the frame handshake's sender screen" \
    'src/lib/pluginFrameBootstrap.test.ts::refuses a port from anyone but its embedder' \
    pluginframe_bootstrap.js 'if (event.source !== window.parent) { return; }' 'if (event.source !== window.parent) { /* defanged */ }'

mutate "the frame handshake's marker screen" \
    'src/lib/pluginFrameBootstrap.test.ts::refuses a port that does not carry the host'"'"'s own marker' \
    pluginframe_bootstrap.js 'if (!event.data || event.data.parley !== "bridge") { return; }' 'if (!event.data || event.data.parley !== "bridge") { /* defanged */ }'

mutate "the handshake happening only once" \
    'src/lib/pluginFrameBootstrap.test.ts::takes the embedder'"'"'s port and then stops listening to the window' \
    pluginframe_bootstrap.js 'window.removeEventListener("message", onHandshake);' '/* the frame goes on listening */'

target internal/api

mutate "the screen on a design token's value" \
    'TestTheFrameBootstrapScreensATokenValueAndNotOnlyItsName' \
    pluginframe_bootstrap.js 'if (COLOR.test(value)) { root.style.setProperty("--color-" + key, value); }' 'root.style.setProperty("--color-" + key, value);'

mutate "the plugin UI bundle path screen" \
    'TestThePluginFrameRefusesANameThatClimbsOutOfThePluginDirectory' \
    pluginframe.go 'if field == "" || strings.ContainsAny(field, `/\`) || strings.Contains(field, "..") {
			return nil, fmt.Errorf("%q is not a usable plugin name or version", field)' 'if false {
			return nil, fmt.Errorf("%q is not a usable plugin name or version", field)'

# The panel list is the one plugin surface a link guest can reach. The grants
# in it are safe to disclose — the host re-checks each at the effect — but the
# *enumeration* is tenant metadata: without the org predicate one link to one
# standup lists every install on the instance.
mutate "the org filter on the panel list" \
    'TestPluginPanelsAreScopedToTheRoomsOwnOrg' \
    pluginpanels.go 'where i.enabled and i.org_id = $1' 'where i.enabled and $1 is not null'

mutate "the audit's check that the named plugin is installed" \
    'TestAnActionNamingAPluginThisInstanceDoesNotRunIsNotRecorded' \
    pluginaudit.go '`select exists (select 1 from plugin_installs where name = $1 and org_id = $2 and enabled)`' '`select $1::text is not null and $2::text is not null`'

# The org predicate is the other half of the same check: without it a plugin
# any tenant installed vouches for an action in every other tenant's room, and
# a foreign plugin's name lands in this org's log.
mutate "the org predicate on the audit's install check" \
    'TestAPluginInstalledInAnotherOrgDoesNotSatisfyTheAuditCheck' \
    pluginaudit.go 'where name = $1 and org_id = $2 and enabled)`' 'where name = $1 and ($2 = $2) and enabled)`'

# A record naming the wrong person is worse than no record: it reads as
# evidence. The actor is the caller, never the org's first member.
mutate "the actor on a plugin action record" \
    'TestAPluginActionIsAttributedToTheActingUser' \
    pluginaudit.go 'p, _ := PrincipalFrom(ctx)' 'p, _ := PrincipalFrom(ctx)
	p.UserID = sessionFrom(ctx).FacilitatorID'

mutate "the audit's success gate" \
    'TestARefusedPluginActionIsNotRecorded' \
    pluginaudit.go 'if rec.status < 200 || rec.status >= 300 {' 'if false {'

# The live session surface: the first time WASM code can read a room. Its two
# guards are the org boundary and the closed patch document, and neither is
# visible to any test that calls the host functions with no server behind them.
mutate "the org boundary on a plugin's view of a room" \
    'TestAPluginCannotReadOrPatchAnotherOrgsRoom' \
    pluginsessions.go 'func sameOrg(sessionOrgID, installOrgID string) bool { return sessionOrgID == installOrgID }' 'func sameOrg(sessionOrgID, installOrgID string) bool { return true } //nolint'

# The org boundary is necessary and is not sufficient. Revealing a poker room is
# a facilitator-only action; without this check a plugin patches {"revealed":
# true} at a poker room in its own org and turns every hidden vote in it into a
# readable one, having never been the facilitator of anything.
mutate "the kind-ownership boundary on a plugin's view of a room" \
    'TestAPluginCannotReadOrRevealAPokerRoomItDoesNotProvide' \
    pluginsessions.go 'func ownsKind(installProvidesTheKind bool) bool { return installProvidesTheKind }' 'func ownsKind(installProvidesTheKind bool) bool { return true } //nolint'

# Both boundaries above are decided from an answer the store gives, and the
# guard is what happens when it cannot give one: the refusal is returned, never
# downgraded to "yes". Nothing else in the package can see it — every fixture
# has a database that answers — so swallowing the error leaves the entire
# internal/api suite green, this test included until it existed.
mutate "the fail-closed answer to an unresolvable kind-ownership question" \
    'TestAnUnanswerableOwnershipQuestionRefusesRatherThanGrants' \
    pluginsessions.go 'provides, err := p.providesKind(ctx, installID, sess.Kind)
	if err != nil {
		return store.Session{}, err
	}' 'provides, err := p.providesKind(ctx, installID, sess.Kind)
	if err != nil {
		provides = true
	}'

mutate "the ended-room guard on a plugin patch" \
    'TestAPluginPatchIsBoundedAndRefusedOnAnEndedRoom' \
    pluginsessions.go 'where id = $1 and ended_at is null`, sess.ID, doc.Phase, doc.Revealed)' 'where id = $1`, sess.ID, doc.Phase, doc.Revealed)'

mutate "the closed patch document" \
    'TestAPluginPatchIsBoundedAndRefusedOnAnEndedRoom' \
    pluginsessions.go 'dec.DisallowUnknownFields()' '// every field a plugin sends is accepted'

target web/src web

mutate "the frame sandbox attribute" \
    'src/components/PluginPanel.test.tsx::sandboxes the frame without allow-same-origin' \
    lib/pluginBridge.ts 'export const PLUGIN_SANDBOX = "allow-scripts";' 'export const PLUGIN_SANDBOX = "allow-scripts allow-same-origin";'

mutate "inerting a plugin frame under a modal" \
    'src/components/PluginPanel.test.tsx::marks the frame inert while a host modal is open' \
    components/PluginPanel.tsx 'el.toggleAttribute("inert", modalOpen);' 'el.toggleAttribute("inert", false);'

mutate "the reveal gate on vote values crossing the bridge" \
    'src/lib/pluginBridge.test.ts::keeps hidden votes hidden before the reveal' \
    lib/pluginBridge.ts 'if (env.revealed && s.votes) {' 'if (s.votes) {' \
    lib/pluginBridge.ts 'if (env.revealed && s.results) story.results = s.results;' 'if (s.results) story.results = s.results;'

mutate "the session:read grant check" \
    'src/lib/pluginBridge.test.ts::hands a plugin with no session:read grant nothing at all' \
    lib/pluginBridge.ts 'if (!grants.includes(GRANT_SESSION_READ)) return null;' 'if (grants.includes("no-such-grant")) return null;'

mutate "the session:act grant check" \
    'src/lib/pluginBridge.test.ts::refuses an action the plugin was not granted' \
    lib/pluginBridge.ts 'if (!opts.grants.includes(GRANT_SESSION_ACT)) {' 'if (false) {'

mutate "the inbound message size cap" \
    'src/lib/pluginBridge.test.ts::drops an oversize message from the plugin instead of processing it' \
    lib/pluginBridge.ts 'if (overMessageCap(raw)) {' 'if (false) {'

mutate "the inbound message rate cap" \
    'src/lib/pluginBridge.test.ts::trips the breaker when a plugin floods the port' \
    lib/pluginBridge.ts 'if (stamps.length >= MAX_MESSAGES_PER_SECOND) {' 'if (false) {'

mutate "the outbound message size cap" \
    'src/lib/pluginBridge.test.ts::bounds what the host pushes into the frame too' \
    lib/pluginBridge.ts 'if (overMessageCap(body)) {
        opts.onFailure("oversize-outbound");' 'if (false) {
        opts.onFailure("oversize-outbound");'

# The action name is a path segment, and an unscreened one is a path
# expression: "../../../me" is normalised out of the actions path by the same
# URL parser fetch uses, and the request that results carries the user's own
# cookie, is same-origin, and lands outside the only route group that audits
# plugin actions. Screened in the bridge, before it can be a URL...
mutate "the action-name screen on the bridge" \
    'src/lib/pluginBridge.test.ts::refuses an action name that could climb out of the actions path' \
    lib/pluginBridge.ts 'if (!isActionName(action)) {' 'if (!isActionName(action) && false) {'

# ...and again at the construction site, which is the one place every caller
# passes through however it got the name.
mutate "the action-name screen at the request construction site" \
    'src/lib/api.test.ts::builds no request at all from an action name that is not a plain name' \
    lib/api.ts 'if (!isActionName(name)) {' 'if (false) {'

mutate "the path-segment encoding of an action request" \
    'src/lib/api.test.ts::escapes the session id and the action name into their own path segments' \
    lib/api.ts '`/api/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(name)}`' '`/api/sessions/${sessionId}/actions/${name}`'

# Coalescing has to keep the *newest* state: a frame left holding a superseded
# round has no way to know it is stale.
mutate "the coalescer keeping the newest state" \
    'src/lib/pluginBridge.test.ts::coalesces two pushes in one interval onto the newer state' \
    lib/pluginBridge.ts 'pending = body;
      if (pushTimer) return;' 'if (pending === null) pending = body;
      if (pushTimer) return;'

# The cap is documented in bytes; .length counts UTF-16 code units, and CJK is
# three bytes to the unit.
mutate "the message cap being measured in bytes" \
    'src/lib/pluginBridge.test.ts::measures the message cap in bytes rather than UTF-16 code units' \
    lib/pluginBridge.ts 'if (body.length * 3 <= MAX_MESSAGE_BYTES) return false;' 'if (body.length <= MAX_MESSAGE_BYTES) return false;'

mutate "the handshake timeout" \
    'src/lib/pluginBridge.test.ts::renders an explicit failure rather than a blank rectangle when the frame never answers' \
    lib/pluginBridge.ts 'opts.onFailure("handshake-timeout");' '// the frame is simply never given up on'

# The last wire, and the one no handler test can see. Every guard above is
# broken inside a package whose own tests construct the app directly — which is
# exactly how the plugin UI shipped dead: main built api.Options and never set
# PluginDir, so the frame route and the panel list took their empty-directory
# early return in the real binary while every test that passed its own dir
# stayed green. The mutation here cuts that wire, and the test that must go red
# is the one that drives an app built from main's own option mapping.
target cmd/parley

mutate "main wiring the plugin directory into the HTTP layer" \
    'TestMainsOptionsServeThePluginUI' \
    main.go '		PluginDir: cfg.PluginDir,' ''

restore_all

echo
if [ "$harness_failures" -ne 0 ]; then
    echo "$harness_failures of $checked guard mutations could not be scored at all —"
    echo "  this harness's own bookkeeping is broken, not (necessarily) the guards."
fi
if [ "$failures" -ne 0 ]; then
    echo "$failures of $checked guard mutations survived. Each one is a guard with no test behind it."
fi
if [ "$failures" -ne 0 ] || [ "$harness_failures" -ne 0 ]; then
    exit 1
fi
echo "all $checked guard mutations were caught."
