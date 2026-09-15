# Optional quality passes (conditional — read only when the gate fires)

These passes fire on a minority of issues. The spine gates each one; read the matching section
here only when its gate is true. All skip **silently** when the relevant skill/CLI isn't
installed — none is a hard dependency of epic-worker.

Skill lookup: `.cursor/skills/<name>/SKILL.md`, else `~/.cursor/skills/<name>/SKILL.md`.
Do not look under `~/.claude/skills/` unless a path here still names it as a fallback.

---

## §6b — UI work: load Impeccable design context (before writing UI code/tests)

Gate (any one true → UI work):

- Issue labels include `area:web`, `ui`, `frontend`, `a11y`, `accessibility`, or a "this changes pixels" signal.
- Discovery puts changes in `web/src/**/*.{tsx,css}` or `site/src/**/*.{astro,mdx,css}`.
- Acceptance criteria reference visual concerns (component, page, layout, form, modal, button, screenshot).
- The issue has image attachments.

…and the project has the **`impeccable`** skill:

1. **Load the project's design context once** if the skill documents a loader script. Read the full JSON output. Reuse it across this run.
2. **Plan before implementing** *for new components or new pages* — follow that skill's shape-and-confirm flow before writing the RED test.
3. **For existing-surface tweaks**, skip shape — loaded context is enough; go straight to TDD.

If Impeccable is **not** installed, skip silently. Parley tokens are `web/src/tokens.css`; match existing components rather than inventing a second design language.

---

## §10b — SonarQube analysis (before push)

**Parley has no SonarQube MCP and no `sonar-project.properties`.** Skip this pass.

---

## §10c — UI quality pass: Impeccable (only when §6b loaded design context)

Catch design-system drift and a11y regressions before a reviewer flags them.

1. **Deterministic anti-pattern check** if `npx impeccable` is available, against changed `.tsx`/`.css` files (exclude tests).
2. Follow the installed skill's audit / critique steps for new pages or greenfield components only.

**Match effort to scope:** a one-line copy or padding fix earns only layer 1. Skill or CLI absent → skip silently.

---

## §10d — Laziness pass: ponytail-review (before push)

You wrote this diff as a `Task` subagent, so ponytail's session hook never constrained you.

If **`ponytail-review`** is installed, invoke it against your diff.

Triage:

- **Cheap, behavior-preserving cuts** — fold into GREEN if caught in time, else `refactor(<scope>): simplify per ponytail-review`. Re-run the suite.
- **Cuts that change behavior or need a test rewrite** — record for the Step 13 `Ponytail` line.
- **`Lean already. Ship.`** — record `clean`.

Never delete your TDD test to win a line-count. A one-line fix earns no pass; a new module or anything past ~40 lines does. Skill absent → skip silently.
