# Applying a fix

- vibesenpai never writes a project file or sends a prompt. Apply drafts a request into the prompt
  box (`$.prompt.fill`, never over a typed draft); the developer's Enter is the yes, and the agent
  makes the change under the harness's own permission prompt. The pane is the only place to apply
  (D70); with no prompt box the request goes to the clipboard, else it is shown to copy by hand.
- A finding's own fix is computed by the standing pass into `finding-fixes.json`, redacted at
  construction (`src/fix-file.ts`); the pane never parses a session to build one.
- The core (`applyPlan` in `src/fix.ts`) names a target, never a file. Each harness's adapter
  (`src/harness/claude-code.ts`) names the file and words the request. Claude Code: rules go to
  `.claude/rules/vibesenpai.md` with one pointer line in `CLAUDE.md`; no CLAUDE.md word budget.
- Every request ends with `(vibesenpai fix <id>)` (`src/fix-marker.ts`). The parser sets
  `Event.fixApplied` from a developer prompt or a developer command's output carrying it;
  `compute-standing` stores the earliest sighting per project (`fix_applied`) and whether our rule
  text was seen loaded (`rule_loaded`, a hash of our own text). Applied is never set by a button.
- A fix id hashes what the fix is for (target, dimension, reason), never its wording.
- Before / since are counts in one project, never rates. A rule counts from when it was first seen
  loaded, not when it was requested. Rules load at session start or on compaction, with no reload
  command. The applying session, and a session the rule first loaded into mid-way, are in neither window.
  The denominator follows the method: judged sessions for model dimensions.
- Hook fixes have no Apply until each Stop-hook snippet is bounded and tested: an `exit 2` hook with
  an unfilled placeholder traps every turn.
- A judged finding's own fix comes first (`src/finding-fix.ts`, D67); the dimension's fix is the
  fallback. Its key is what it is for (`action:git push`, `path:…`, `instr:<hash>`, `quote:<hash>`)
  and its outcome counts that key; a `quote:` key counts the dimension and says "same kind".
- Targets: `project-permissions`, `project-hooks` (a PreToolUse guard; a Stop hook stays printed),
  `scoped-instructions`, `project-check`, `project-agent`. A fix from another project is shown with no
  Apply: it would land in the wrong repo.
