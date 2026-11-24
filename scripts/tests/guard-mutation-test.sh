#!/usr/bin/env bash
# Exercise the real harness with tiny source trees and a fake Go runner.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/scripts" "$test_root/bin"
# Keep the harness implementation, replacing only its mutation catalog.
sed '/^mutate "the private-address screen"/,$d' "$repo_root/scripts/guard-mutation.sh" >"$test_root/scripts/guard-mutation.sh"
for tree in internal/plugin internal/plugin/bundle internal/api internal/api/custody internal/store web/src cmd/parley internal/standup internal/poker internal/poker/publication; do
    mkdir -p "$test_root/$tree"
done
for tree in internal/plugin internal/api internal/poker; do
    echo pristine >"$test_root/$tree/guard.go"
done
cat >"$test_root/bin/go" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *' XXNONEXX '* ]]; then
    echo compile >>calls
    exit 0
fi
if grep -q broken internal/plugin/guard.go; then
    grep -q broken internal/poker/guard.go || exit 0
    echo atomic >>calls
    exit 1
fi
if grep -q broken internal/api/guard.go; then
    echo api-mutant >>calls
    exit 1
fi
grep -qx pristine internal/poker/guard.go || exit 1
echo baseline >>calls
RUNNER
chmod +x "$test_root/bin/go"
cat >>"$test_root/scripts/guard-mutation.sh" <<'CASES'
mutate atomic TestGuard guard.go pristine broken ../poker/guard.go pristine broken
target internal/api
mutate next TestGuard guard.go pristine broken
target internal/poker/publication
mutate nested TestGuard ../../plugin/guard.go pristine broken ../../poker/guard.go pristine broken
target internal/api
mutate after-nested TestGuard guard.go pristine broken
[[ "$checked" == 4 && "$harness_failures" == 0 && "$failures" == 0 ]]
CASES
PATH="$test_root/bin:$PATH" bash "$test_root/scripts/guard-mutation.sh"
printf 'baseline\ncompile\natomic\nbaseline\ncompile\napi-mutant\nbaseline\ncompile\natomic\nbaseline\ncompile\napi-mutant\n' >"$test_root/expected"
cmp "$test_root/expected" "$test_root/calls"
for tree in internal/plugin internal/api internal/poker; do
    grep -qx pristine "$test_root/$tree/guard.go"
done
echo 'PASS: cross-tree baselines, atomic mutants, compile gates, and cleanup'

# A failed copy must prevent a baseline and reject the run, including at exit.
sed '/^mutate "the private-address screen"/,$d' "$repo_root/scripts/guard-mutation.sh" >"$test_root/scripts/guard-mutation.sh"
cat >>"$test_root/scripts/guard-mutation.sh" <<'CASES'
cp() { return 1; }
mutate unrestorable TestGuard guard.go pristine broken
[[ "$harness_failures" == 1 && "$checked" == 1 ]]
CASES
: >"$test_root/calls"
if PATH="$test_root/bin:$PATH" bash "$test_root/scripts/guard-mutation.sh" >"$test_root/error" 2>&1; then
    echo 'FAIL: restoration error accepted' >&2
    exit 1
fi
grep -q 'could not restore pristine source trees' "$test_root/error"
[[ ! -s "$test_root/calls" ]]
echo 'PASS: restoration failures reject the run before testing'
