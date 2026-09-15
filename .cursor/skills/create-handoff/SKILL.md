---
name: create-handoff
description: Write or update a durable, resumption-ready session handoff document (original task, steps taken, issues, gotchas, failed remediations, lessons, next steps) saved outside the git repo at ~/.cursor/projects/<slug>/handoffs/. Use this whenever the user says "create a handoff", "write up a handoff", "update the handoff", "hand this off", "/create-handoff", "summarize this session for the next one", "document where we are before I lose context", "I'm running low on context", "context is filling up", "let's checkpoint this", "write this down before we stop", or is otherwise about to end, pause, compact, or hand off a long working session. Also use it proactively when a session has produced substantial state (open PRs, half-finished migrations, dead ends worth remembering) and the user signals they're wrapping up. If the session was resumed from an existing handoff doc, this updates that doc in place rather than creating a second one.
---

# Create Handoff

Write one markdown file that lets a *fresh* session — no memory of this
conversation — pick the work up cold and be productive in under a minute.

The failure mode this prevents: a status report ("we made good progress on the
billing fix") instead of a working brief ("PR #6021 is open and red on Test
Python; the cause is X; run Y first"). Write for a reader with zero context.

**Announce at start:** "Using create-handoff to write a resumption brief."

**Never write the handoff into the repo working tree.** Stray `HANDOFF-*.md`
files pollute `git status` and eventually get committed by accident.

## Cursor harness

Claude Code original; this is the Cursor port.

| Claude Code | Cursor |
|---|---|
| `~/.claude/projects/<slug>/handoffs/` | `~/.cursor/projects/<slug>/handoffs/` (slug = repo root with non-alphanumerics → `-`, no leading `/`) |
| Scratchpad path session id | Agent transcript UUID under `~/.cursor/projects/<slug>/agent-transcripts/`, else `date -u +%Y%m%dT%H%M%SZ` |
| `AskUserQuestion` | Ask in the conversation and wait |
| `auto-mode` | Auto, or Cursor Grok 4.6 when that is the session model |

Do not invent Claude `Agent` / `AskUserQuestion` calls. Do not dispatch a `Task` subagent to write the handoff — this session already has the context.

When listing existing docs, also check `$HOME/.claude/projects/<claude-slug>/handoffs/` if it exists, so a brief started under Claude Code can be updated in place. Prefer writing new files under the Cursor path.

## 1. Resolve the directory

```bash
R="$(git rev-parse --git-common-dir 2>/dev/null)" && R="$(dirname "$(cd "$R" && pwd)")" || R="$PWD"
slug="$(printf '%s' "$R" | sed 's|^/||; s|[^A-Za-z0-9]|-|g')"
D="$HOME/.cursor/projects/$slug/handoffs"
mkdir -p "$D"
echo "$D"
ls -t "$D"/*.md 2>/dev/null
claude_slug="$(printf '%s' "$R" | sed 's|[^A-Za-z0-9]|-|g')"
ls -t "$HOME/.claude/projects/$claude_slug/handoffs"/*.md 2>/dev/null
```

Anchoring on `--git-common-dir` rather than the worktree keeps every worktree of
a repo pointed at one handoffs dir instead of scattering docs. Check that the
printed path names the project you actually worked in — the shell's cwd can
reset between calls, and a handoff filed under the wrong project is a handoff
nobody finds. If it doesn't match, re-run the snippet with `R` set to the repo
the work actually happened in rather than filing under the wrong slug.

## 2. Update or create

Update an existing doc when the user names one, when this session was resumed
from a handoff you read earlier (look in your own context for a path under
`handoffs/`), or when the listing above shows a doc covering this same work.
Ask when it's genuinely ambiguous — a wrong guess either duplicates or
overwrites. Otherwise create a new file.

New filenames: `<kebab-title>-<session-id>-HANDOFF.md`, where the title names
the *work* — `stripe-webhook-500-sweep`, not `session-notes`. Someone scanning
the directory should know which doc they want without opening any. The session
id is the agent transcript UUID if you can see it; otherwise a UTC timestamp
from `date -u +%Y%m%dT%H%M%SZ`.

## 3. Write it

Use every section below. Coverage is the whole point: left to improvise, it's
the reflective sections — lessons learned, key references, the verify block —
that quietly go missing, and those are exactly what a cold reader needs.

````markdown
---
handoff: <kebab-title>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
sessions:
  - <session-id> (<YYYY-MM-DD>)
repo: <absolute repo root>
branch: <branch>  # worktree: <abs path>, or n/a
status: in-progress | blocked | done
---

# HANDOFF — <Title>

One paragraph: what this work is, where it stands, the single next thing to do.

## 0. Resume in 60 seconds

Run these first — they confirm the world hasn't moved since <date>:

```bash
<command>   # expect: <output that distinguishes done from not-done>
```

| Fact | Value as of <date> |
|---|---|
| Branch / worktree | |
| Open PRs | #NNNN — <title> — <CI state> |
| Last commit | `<sha>` <subject> |
| Env / deploy state | |

## 1. Original task

What the user asked for, in their framing. Include scope changes agreed
mid-session and who decided them.

## 2. Current state

DONE / IN FLIGHT / NOT STARTED. Evidence for every "done" — a PR number, a SHA,
test output. "I made the change" is not evidence.

## 3. Steps taken

Chronological, condensed. What was done, why, what it produced.

## 4. Issues hit + attempted remediations

Per issue: symptom → root cause (or an honest "unknown") → what was tried →
outcome. **Include the attempts that failed and why.** This is the only thing
standing between the next session and an hour re-walking a dead end.

## 5. Gotchas / landmines

Ordering requirements, tools that lie about exit codes, flaky lanes, config that
must change in lock-step. Name the exact trap and the exact workaround.

## 6. Lessons learned

Generalizable takeaways — distinct from gotchas, which are traps. "Do it this
way next time."

## 7. Next steps

Ordered, independently actionable, first command inline, rough estimate.

1. **<action>** — `<exact command>` (~<estimate>)

## 8. Open questions / needs a human

Give the options and a recommendation, not just the question. Flag anything
Auto / Cursor Grok 4.6 can't do (prod mutations, external writes).

## 9. Key files + references

| Path / link | Why it matters |
|---|---|
| `path/to/file.py:142` | <the specific reason> |

## Session log

- <date> · <session-id> — <one line: what this session added>
````

## 4. Updating an existing doc

Keep it current without losing history:

- **Refresh in place** — the opening paragraph, §0, §2, §7, §8. A "next step"
  that's already done actively misleads.
- **Append / merge** — §3, §4, §5, §6, §9. Never delete a prior session's dead
  end because it's resolved; mark it `(resolved <date>: <how>)`. The record of
  what failed is the point.
- **§1** — leave alone unless scope changed; then append a dated note.
- **Frontmatter** — bump `updated`, append this session's id to `sessions`,
  update `status` and `branch`. Always append a session-log line.

Read the whole file before editing. Handoffs get long, and a blind overwrite of
the top half drops the section someone needs most.

## Quality bar

- Every claim has an anchor: absolute path, `file.py:142`, `#6021`, a SHA, or a
  command with its expected output.
- Failed attempts are written down, not just successful ones.
- Each §0 command can actually fail. A check whose broken form and whose
  all-clear look identical (`grep A | grep B` on separate lines, a test that
  skips when its fixture is absent) gives false confidence — state the expected
  output so a wrong command is distinguishable from a passing one.
- Counts and totals stated in more than one place agree with each other.
- No conversational residue ("as I mentioned earlier"). The reader wasn't there.
- Dates on anything time-sensitive, so staleness is judgeable.
- The file is under `~/.cursor/projects/<slug>/handoffs/` — not the repo.
  Updating a Claude Code brief in `~/.claude/projects/…/handoffs/` is allowed
  when that is the doc this session resumed from.
