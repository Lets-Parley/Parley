# Commit & PR templates

## Conventional Commit type cheat sheet

- `feat` — new user-visible behavior
- `fix` — bug fix
- `refactor` — internal change, no behavior diff
- `perf` — measurable performance win
- `test` — test-only change
- `chore` — tooling, deps, non-source changes
- `docs` — docs only
- `feat!` / footer `BREAKING CHANGE:` — breaking change (no automated changelog here)

Scope like this repo: `feat(web):`, `fix(hub):`, `feat(db,api):`.

## RED commit (failing tests, focused — optional but recommended)

```bash
git add <test files only>
git commit -m "$(cat <<'EOF'
test(<scope>): cover <behavior> for #<ISSUE>
EOF
)"
```

## GREEN commit

```bash
git commit -m "$(cat <<'EOF'
feat(<scope>): <imperative summary>

<optional body — explain the why if non-obvious. Closes #<ISSUE>.>
EOF
)"
```

## PR body (Step 11) — **no AI attribution, no "Generated with" footer, no 🤖 emoji**

```bash
gh pr create --base "$BASE_BRANCH" --title "<conventional title>" --body "$(cat <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Why
<one paragraph: the problem this solves, linking back to the epic if useful>

## Changes
- <user-visible change>
- <internal change worth flagging>

## Test plan
- [ ] <how a reviewer can verify locally>
- [ ] `TEST_DATABASE_URL` set for `go test -p 1 -race ./...`
- [ ] CI green

Closes #<ISSUE>
EOF
)"
```
