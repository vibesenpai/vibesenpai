---
description: Write a self-contained HTML report of your sessions
allowed-tools: Bash(node:*)
---

!`node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" report --html`

Give the user the file path from the output above, on its own line, and the
command to open it. Nothing else.

Do NOT summarise the findings, list the sessions, or describe what is in the
report. It is a file; they will read it. Repeating its contents here would
replace the evidence with a paraphrase of the evidence.
