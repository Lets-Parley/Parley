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
TREES=(internal/plugin internal/api web/src)
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

failures=0
checked=0

patch_once() {
    python3 -c 'import sys
path, find, replace = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    body = fh.read()
with open(path, "w") as fh:
    fh.write(body.replace(find, replace, 1))' "$1" "$2" "$3"
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

    while [ "$#" -ge 3 ]; do
        local file=$1 find=$2 replace=$3
        shift 3
        if ! grep -qF -- "$find" "$SRC/$file"; then
            echo "MUTATION SETUP FAILED: $name — this anchor is no longer in $file:"
            echo "  $find"
            failures=$((failures + 1))
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
            failures=$((failures + 1))
            return
        fi
    elif ! go test -run 'XXNONEXX' -count=1 "$PKG" >"$LOG" 2>&1; then
        echo "MUTATION DID NOT COMPILE: $name — a build break is not a caught mutation."
        sed -n '1,40p' "$LOG"
        failures=$((failures + 1))
        return
    fi

    # -timeout keeps a mutation that removes a timeout from hanging the leg
    # forever; a hung run is still a red run, which is the answer we want.
    if { [ "$RUNNER" = "web" ] && (cd web && npx vitest run "$tests") >"$LOG" 2>&1; } ||
        { [ "$RUNNER" = "go" ] && go test "$PKG" -run "$tests" -count=1 -timeout 120s >"$LOG" 2>&1; }; then
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


# ---------------------------------------------------------------------------
# The frontend half of the sandbox: the framed route's header carve-out, and
# the bridge that is the only thing a plugin's UI can reach.
# ---------------------------------------------------------------------------

target internal/api

mutate "the plugin frame's route-group carve-out" \
    'TestThePluginFrameIsNotDeniedByXFrameOptions' \
    router.go 'a.mountPluginFrame(root)
	r := root.With(securityHeaders)' 'r := root.With(securityHeaders)
	a.mountPluginFrame(r)'

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

mutate "the plugin UI bundle path screen" \
    'TestThePluginFrameRefusesANameThatClimbsOutOfThePluginDirectory' \
    pluginframe.go 'if field == "" || strings.ContainsAny(field, `/\`) || strings.Contains(field, "..") {
			return nil, fmt.Errorf("%q is not a usable plugin name or version", field)' 'if false {
			return nil, fmt.Errorf("%q is not a usable plugin name or version", field)'

mutate "the audit's check that the named plugin is installed" \
    'TestAnActionNamingAPluginThisInstanceDoesNotRunIsNotRecorded' \
    pluginaudit.go '`select exists (select 1 from plugin_installs where name = $1 and enabled)`' '`select $1::text is not null`'

mutate "the audit's success gate" \
    'TestARefusedPluginActionIsNotRecorded' \
    pluginaudit.go 'if rec.status < 200 || rec.status >= 300 {' 'if false {'

target web/src web

mutate "the frame sandbox attribute" \
    'src/components/PluginPanel.test.tsx' \
    lib/pluginBridge.ts 'export const PLUGIN_SANDBOX = "allow-scripts";' 'export const PLUGIN_SANDBOX = "allow-scripts allow-same-origin";'

mutate "inerting a plugin frame under a modal" \
    'src/components/PluginPanel.test.tsx' \
    components/PluginPanel.tsx 'el.toggleAttribute("inert", modalOpen);' 'el.toggleAttribute("inert", false);'

mutate "the reveal gate on vote values crossing the bridge" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'if (revealed && s.votes) {' 'if (s.votes) {' \
    lib/pluginBridge.ts 'if (revealed && s.results) story.results = s.results;' 'if (s.results) story.results = s.results;'

mutate "the session:read grant check" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'if (!grants.includes(GRANT_SESSION_READ)) return null;' 'if (grants.includes("no-such-grant")) return null;'

mutate "the session:act grant check" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'if (!opts.grants.includes(GRANT_SESSION_ACT)) {' 'if (false) {'

mutate "the inbound message size cap" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'if (raw.length > MAX_MESSAGE_BYTES) {' 'if (false) {'

mutate "the inbound message rate cap" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'if (stamps.length >= MAX_MESSAGES_PER_SECOND) {' 'if (false) {'

mutate "the outbound message size cap" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'return body.length > MAX_MESSAGE_BYTES;' 'return false && body.length > MAX_MESSAGE_BYTES;'

mutate "the handshake timeout" \
    'src/lib/pluginBridge.test.ts' \
    lib/pluginBridge.ts 'opts.onFailure("handshake-timeout");' '// the frame is simply never given up on'

restore_all

echo
if [ "$failures" -ne 0 ]; then
    echo "$failures of $checked guard mutations survived. Each one is a guard with no test behind it."
    exit 1
fi
echo "all $checked guard mutations were caught."
