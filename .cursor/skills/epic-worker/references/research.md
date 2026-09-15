# Step 6 — Research (token-budgeted)

The cheapest research is the one you don't do twice. Before writing code or tests:

Parley has **no code graph / graphify MCP**. Do not look for `query_graph`. Use `Grep` / `Glob` and one Explore pass.

1. **Use the manager-provided context first.** If `epic-worker-manager` dispatched you, the prompt already includes the issue body, extracted acceptance criteria, the epic's Constraints/Scope, and a `likely_files_in_scope` set. Trust those. Don't re-run `gh issue view` or re-read the epic unless you need a field that wasn't passed.

2. **Spawn ONE Explore `Task` to map the area.** Pass it: the acceptance criteria, the scope-set hint, and any symbols/files the issue names. Ask for "file paths + 3-line excerpts of the most relevant existing tests and the module under change. Under 400 words."

   ```
   Task({
     subagent_type: "explore",
     model: "cursor-grok-4.6-medium",
     description: "Map area for issue #N",
     prompt: "..."
   })
   ```

   That slug is Cursor Grok 4.6. If a newer Grok slug is on the Task allow-list, use that. Do not invent Claude `Agent({ subagent_type: "Explore", model: "haiku" })`.

3. **Stay in-repo.** There is no Sourcegraph skill for this project. For in-package work, stick with the Explore report plus targeted `Grep`.

4. **Do not read full files directly** unless the Explore report flags one as critical and you need the exact implementation to write a correct test.

5. **Budget: if you find yourself wanting a 3rd extra read or a 2nd Explore call, stop.** Surface to the user instead of digging deeper.

Write a brief plan (in this conversation, not as a file) listing:

- The behavior change required
- The smallest test that would prove it
- Files you expect to touch
- Anything you decided is *out of scope*

If the plan reveals the issue is too large or actually two issues, surface that and let the user decide.
