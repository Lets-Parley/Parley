#!/bin/sh
# Fixture tests for scripts/check-agents-budget.sh.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
checker="$repo_root/scripts/check-agents-budget.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Minimal valid tree under $1 (directory used as fake repo root).
seed_ok() {
  root=$1
  mkdir -p "$root/docs/agents" "$root/scripts"
  cp "$checker" "$root/scripts/check-agents-budget.sh"
  chmod +x "$root/scripts/check-agents-budget.sh"

  cat >"$root/CODE_STANDARDS.md" <<'EOF'
# standards
<a id="working-rules"></a>
## Working rules
EOF

  cat >"$root/docs/agents/ship.md" <<'EOF'
# ship
<a id="migrations"></a>
## Migrations
EOF
  cat >"$root/docs/agents/http.md" <<'EOF'
# http
<a id="csrf"></a>
## CSRF
EOF
  cat >"$root/docs/agents/plugins.md" <<'EOF'
# plugins
<a id="kinds"></a>
## Kinds
EOF

  # Keep under 12288 bytes with valid links.
  cat >"$root/AGENTS.md" <<'EOF'
# agents
See [CODE_STANDARDS.md#working-rules](CODE_STANDARDS.md#working-rules).
Children: [docs/agents/ship.md](docs/agents/ship.md),
[docs/agents/http.md](docs/agents/http.md),
[docs/agents/plugins.md](docs/agents/plugins.md).
Also [ship migrations](docs/agents/ship.md#migrations).
EOF
}

run_checker() {
  root=$1
  (
    cd "$root" || exit 1
    git init -q
    git add AGENTS.md CODE_STANDARDS.md docs scripts
    git -c user.name=t -c user.email=t@example.com commit -q -m init
    ./scripts/check-agents-budget.sh
  )
}

# --- happy path ---
seed_ok "$test_root/ok"
run_checker "$test_root/ok" >/dev/null || fail "valid tree unexpectedly failed"

# --- missing child ---
seed_ok "$test_root/missing"
rm "$test_root/missing/docs/agents/ship.md"
if run_checker "$test_root/missing" >/dev/null 2>"$test_root/missing.err"; then
  fail "missing child unexpectedly passed"
fi
grep -q 'missing required file' "$test_root/missing.err" || fail "missing child: wrong error"

# --- empty AGENTS ---
seed_ok "$test_root/empty"
: >"$test_root/empty/AGENTS.md"
if run_checker "$test_root/empty" >/dev/null 2>"$test_root/empty.err"; then
  fail "empty AGENTS unexpectedly passed"
fi
grep -q 'empty' "$test_root/empty.err" || fail "empty AGENTS: wrong error"

# --- dangling fragment ---
seed_ok "$test_root/dangling"
cat >"$test_root/dangling/AGENTS.md" <<'EOF'
# agents
[std](CODE_STANDARDS.md#working-rules)
[ship](docs/agents/ship.md)
[http](docs/agents/http.md)
[plugins](docs/agents/plugins.md)
[bad](docs/agents/ship.md#no-such-anchor)
EOF
if run_checker "$test_root/dangling" >/dev/null 2>"$test_root/dangling.err"; then
  fail "dangling fragment unexpectedly passed"
fi
grep -q 'dangling fragment' "$test_root/dangling.err" || fail "dangling: wrong error"

# --- duplicate id ---
seed_ok "$test_root/dup"
cat >"$test_root/dup/docs/agents/ship.md" <<'EOF'
# ship
<a id="migrations"></a>
## Migrations
<a id="migrations"></a>
## Again
EOF
if run_checker "$test_root/dup" >/dev/null 2>"$test_root/dup.err"; then
  fail "duplicate id unexpectedly passed"
fi
grep -q 'duplicate anchor' "$test_root/dup.err" || fail "duplicate: wrong error"

# --- orphan / fourth child ---
seed_ok "$test_root/orphan"
echo '# extra' >"$test_root/orphan/docs/agents/extra.md"
if run_checker "$test_root/orphan" >/dev/null 2>"$test_root/orphan.err"; then
  fail "orphan child unexpectedly passed"
fi
grep -q 'exactly' "$test_root/orphan.err" || fail "orphan: wrong error"

# --- missing markdown link to a child ---
seed_ok "$test_root/nolink"
cat >"$test_root/nolink/AGENTS.md" <<'EOF'
# agents
[std](CODE_STANDARDS.md#working-rules)
[ship](docs/agents/ship.md)
[http](docs/agents/http.md)
EOF
if run_checker "$test_root/nolink" >/dev/null 2>"$test_root/nolink.err"; then
  fail "missing child link unexpectedly passed"
fi
grep -q 'markdown link to docs/agents/plugins.md' "$test_root/nolink.err" || fail "nolink: wrong error"

# --- over hard byte limit ---
seed_ok "$test_root/huge"
python3 - <<PY
from pathlib import Path
root = Path("$test_root/huge")
header = """# agents
[std](CODE_STANDARDS.md#working-rules)
[ship](docs/agents/ship.md)
[http](docs/agents/http.md)
[plugins](docs/agents/plugins.md)
"""
body = header
while len(body.encode("utf-8")) <= 16384:
    body += "x"
root.joinpath("AGENTS.md").write_text(body)
PY
if run_checker "$test_root/huge" >/dev/null 2>"$test_root/huge.err"; then
  fail "oversize AGENTS unexpectedly passed"
fi
grep -q 'bytes (limit' "$test_root/huge.err" || fail "oversize: wrong error"

# --- unexpected nested AGENTS.md ---
seed_ok "$test_root/nested"
mkdir -p "$test_root/nested/internal/api"
echo '# nested' >"$test_root/nested/internal/api/AGENTS.md"
(
  cd "$test_root/nested" &&
    git init -q &&
    git add -A &&
    git -c user.name=t -c user.email=t@example.com commit -q -m nested
)
if (cd "$test_root/nested" && ./scripts/check-agents-budget.sh) >/dev/null 2>"$test_root/nested.err"; then
  fail "nested AGENTS unexpectedly passed"
fi
grep -q 'unexpected instruction entry' "$test_root/nested.err" || fail "nested: wrong error"

# --- non-lowercase fragment still counts as the child link but must fail ---
seed_ok "$test_root/casefrag"
cat >"$test_root/casefrag/AGENTS.md" <<'EOF'
# agents
[std](CODE_STANDARDS.md#working-rules)
[ship](docs/agents/ship.md#Migrations)
[http](docs/agents/http.md)
[plugins](docs/agents/plugins.md)
EOF
if run_checker "$test_root/casefrag" >/dev/null 2>"$test_root/casefrag.err"; then
  fail "non-lowercase fragment unexpectedly passed"
fi
grep -Eq 'invalid fragment|must contain a markdown link' "$test_root/casefrag.err" || fail "casefrag: wrong error"

# --- nested file under docs/agents ---
seed_ok "$test_root/nestedchild"
mkdir -p "$test_root/nestedchild/docs/agents/more"
echo '# secret' >"$test_root/nestedchild/docs/agents/more/secret.md"
if run_checker "$test_root/nestedchild" >/dev/null 2>"$test_root/nestedchild.err"; then
  fail "nested docs/agents file unexpectedly passed"
fi
grep -q 'exactly' "$test_root/nestedchild.err" || fail "nestedchild: wrong error"

# --- path-escape link ---
seed_ok "$test_root/escape"
cat >"$test_root/escape/AGENTS.md" <<'EOF'
# agents
[std](CODE_STANDARDS.md#working-rules)
[ship](docs/agents/ship.md)
[http](docs/agents/http.md)
[plugins](docs/agents/plugins.md)
[bad](docs/agents/ship.md/../../CODE_STANDARDS.md#working-rules)
EOF
if run_checker "$test_root/escape" >/dev/null 2>"$test_root/escape.err"; then
  fail "path-escape link unexpectedly passed"
fi
grep -q 'path-escape markdown link' "$test_root/escape.err" || fail "escape: wrong error"

# --- dangling fragment inside a child file ---
seed_ok "$test_root/childdang"
cat >"$test_root/childdang/docs/agents/http.md" <<'EOF'
# http
<a id="csrf"></a>
## CSRF
See [bad](ship.md#not-an-anchor).
EOF
if run_checker "$test_root/childdang" >/dev/null 2>"$test_root/childdang.err"; then
  fail "child dangling fragment unexpectedly passed"
fi
grep -q 'dangling fragment' "$test_root/childdang.err" || fail "childdang: wrong error"

# --- prose-only id= must not satisfy an anchor ---
seed_ok "$test_root/proseid"
cat >"$test_root/proseid/docs/agents/ship.md" <<'EOF'
# ship
The string id="migrations" appears in prose only.
EOF
cat >"$test_root/proseid/AGENTS.md" <<'EOF'
# agents
[std](CODE_STANDARDS.md#working-rules)
[ship](docs/agents/ship.md#migrations)
[http](docs/agents/http.md)
[plugins](docs/agents/plugins.md)
EOF
if run_checker "$test_root/proseid" >/dev/null 2>"$test_root/proseid.err"; then
  fail "prose-only id unexpectedly passed"
fi
grep -q 'dangling fragment' "$test_root/proseid.err" || fail "proseid: wrong error"

printf 'ok: check-agents-budget fixtures passed\n'
