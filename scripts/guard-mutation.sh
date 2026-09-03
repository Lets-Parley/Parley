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

PKG=./internal/plugin
SRC=internal/plugin
BACKUP=$(mktemp -d)
LOG=$(mktemp)
trap 'cp -a "$BACKUP"/. "$SRC"/ 2>/dev/null || true; rm -rf "$BACKUP" "$LOG"' EXIT
cp -a "$SRC"/. "$BACKUP"/

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
    cp -a "$BACKUP"/. "$SRC"/

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
    if ! go test -run 'XXNONEXX' -count=1 "$PKG" >"$LOG" 2>&1; then
        echo "MUTATION DID NOT COMPILE: $name — a build break is not a caught mutation."
        sed -n '1,40p' "$LOG"
        failures=$((failures + 1))
        return
    fi

    # -timeout keeps a mutation that removes a timeout from hanging the leg
    # forever; a hung run is still a red run, which is the answer we want.
    if go test "$PKG" -run "$tests" -count=1 -timeout 60s >"$LOG" 2>&1; then
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

cp -a "$BACKUP"/. "$SRC"/

echo
if [ "$failures" -ne 0 ]; then
    echo "$failures of $checked guard mutations survived. Each one is a guard with no test behind it."
    exit 1
fi
echo "all $checked guard mutations were caught."
