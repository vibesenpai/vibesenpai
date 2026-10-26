---
description: Set findings aside — pick which, or clear them all
argument-hint: "[id… | all | undo id… | undo all]"
allowed-tools: Bash(node:*), AskUserQuestion
---

!`NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" dismiss --list`

The list above is what can be dismissed. Each line starts with a short id.
The arguments given were: `$ARGUMENTS`

To run the command, use exactly:
`NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" dismiss …`

Follow the first rule that matches, then stop:

1. **The list says there is nothing to dismiss.** Say so in one line.
2. **Arguments start with `undo`.** Run `dismiss --undo <ids>`, or `dismiss --undo --all`
   for `undo all`.
3. **The argument is `all`.** Run `dismiss --all` without asking anything else.
4. **Arguments name ids, or describe findings in words.** Match them to ids from the
   list. If a description could match more than one finding, ask which one. Ask only
   the "Why?" question from step 5, then do step 6.
5. **No arguments.** Ask with AskUserQuestion, using two questions in one call:
   - "Which findings do you want to dismiss?" `multiSelect: true`, header "Findings".
     Offer the three most recent findings, labelled `<id> <dimension>` and described
     by the rest of their line. Make the fourth option "All N findings", with N the
     count from the list. If there are fewer than three findings, offer them all,
     then "All".
   - "Why?" header "Reason". The options are "Wrong: a false positive" and
     "Right, but not worth showing".

   The person may answer "Other" with ids or a description from the list; match it
   as in step 4. If they chose "All", run `dismiss --all`; the reason does not apply.
6. Run `dismiss <ids>`, adding `--wrong` when the reason is a false positive.

Reproduce the command's output in a code block, preserving every line exactly. Add
no summary, no commentary, and no emphasis. Never dismiss anything the person did
not choose.
