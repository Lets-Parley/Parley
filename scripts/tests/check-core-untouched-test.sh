#!/bin/sh
set -eu

# The guarantee the plugin epic rests on is that a whole ceremony can be
# delivered as a plugin without editing the host. An honour claim in a pull
# request description is not that guarantee, so a checker enforces it — and a
# checker nobody tests is the same honour claim one level down.

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
checker="$repo_root/scripts/check-core-untouched.sh"
test_repo=$(mktemp -d)
trap 'rm -rf "$test_repo"' EXIT HUP INT TERM

git -C "$test_repo" init -q
git -C "$test_repo" config user.name "Test Contributor"
git -C "$test_repo" config user.email "contributor@example.com"

commit_paths() {
  message=$1
  shift
  for path in "$@"; do
    mkdir -p "$test_repo/$(dirname -- "$path")"
    echo "$message" >>"$test_repo/$path"
  done
  git -C "$test_repo" add -A
  git -C "$test_repo" commit -q -m "$message"
  git -C "$test_repo" rev-parse HEAD
}

base=$(commit_paths "chore: establish base" internal/api/router.go plugins/README.md web/src/App.tsx)

# A pull request that touches no ceremony plugin is none of this check's
# business: core is where core work belongs.
core_only=$(commit_paths "fix: ordinary core work" internal/api/router.go internal/db/migrations/0099_x.sql)
(cd "$test_repo" && "$checker" "$base" "$core_only")

# A ceremony plugin on its own is the whole point, and must pass.
plugin_only=$(commit_paths "feat: a ceremony as a plugin" plugins/retro/guest/main.go plugins/retro/manifest.json)
(cd "$test_repo" && "$checker" "$core_only" "$plugin_only")

# A ceremony plugin that also edits the host is the failure this exists to
# catch, and it must name the offending path rather than only saying no.
mixed=$(commit_paths "feat: a plugin that needed the host changed" plugins/retro/guest/main.go internal/session/registry.go)
if (cd "$test_repo" && "$checker" "$plugin_only" "$mixed") >"$test_repo/mixed.out" 2>&1; then
  echo "a plugin change that also edited internal/session unexpectedly passed" >&2
  exit 1
fi
grep -q "internal/session/registry.go" "$test_repo/mixed.out"

# Every core tree is core. A guard that only knew about the one tree somebody
# happened to edit would wave the next one through.
for path in internal/api/plugins.go internal/store/sessions.go internal/db/migrations/0100_y.sql \
  internal/plugin/kinds.go cmd/parley/main.go web/src/lib/kinds.ts; do
  before=$(git -C "$test_repo" rev-parse HEAD)
  after=$(commit_paths "feat: reach into $path" plugins/retro/guest/main.go "$path")
  if (cd "$test_repo" && "$checker" "$before" "$after") >"$test_repo/each.out" 2>&1; then
    echo "a plugin change that also edited $path unexpectedly passed" >&2
    exit 1
  fi
  grep -q "$path" "$test_repo/each.out"
done

# Documentation, the checkers themselves and the workflow that runs them are
# not the host. A plugin that has to be written about must still be able to be.
before=$(git -C "$test_repo" rev-parse HEAD)
allowed=$(commit_paths "docs: describe the ceremony" plugins/retro/guest/main.go \
  AGENTS.md site/src/content/docs/project/contributing.mdx scripts/check-core-untouched.sh)
(cd "$test_repo" && "$checker" "$before" "$allowed")

# A deleted core file is a core change too: the diff is what matters, not
# whether the bytes went in or out.
before=$(git -C "$test_repo" rev-parse HEAD)
git -C "$test_repo" rm -q internal/api/router.go
echo removal >>"$test_repo/plugins/retro/guest/main.go"
git -C "$test_repo" add -A
git -C "$test_repo" commit -q -m "feat: delete a core file"
deleted=$(git -C "$test_repo" rev-parse HEAD)
if (cd "$test_repo" && "$checker" "$before" "$deleted") >"$test_repo/deleted.out" 2>&1; then
  echo "deleting a core file alongside a plugin change unexpectedly passed" >&2
  exit 1
fi
grep -q "internal/api/router.go" "$test_repo/deleted.out"

# A range that cannot be resolved is an error, never a pass: a checker that
# reports clean because it could not look is worse than no checker.
if (cd "$test_repo" && "$checker" not-a-revision "$deleted") >"$test_repo/revision.out" 2>&1; then
  echo "an unresolvable revision range unexpectedly passed" >&2
  exit 1
fi
grep -q "cannot resolve revision range" "$test_repo/revision.out"

if (cd "$test_repo" && "$checker" "$deleted") >/dev/null 2>&1; then
  echo "a missing argument unexpectedly passed" >&2
  exit 1
fi

echo "core-untouched checks passed"
