---
description: A self-contained HTML report of your history
allowed-tools: Bash(node:*)
---

!`NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" report --html --open`

Show the output above exactly as it is, and add nothing.

It already says how many sessions and findings the report covers, that it has
been opened, and where the file is. Restating the path, or offering a command
to open a file that is already open, is the duplication this wording exists to
prevent.

Do NOT summarise the findings, list the sessions, or describe what is in the
report. It is a file; they will read it. Repeating its contents here would
replace the evidence with a paraphrase of the evidence.
