---
description: Turn the model reads on or off; the free checks keep running either way
argument-hint: "[on | off]"
allowed-tools: Bash(node:*)
---

The arguments given were: `$ARGUMENTS`

Follow the first rule that matches, then stop:

1. **The argument is `off`.** Run exactly:
   `NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" judge --disable --apply`
2. **The argument is `on`.** Run exactly:
   `NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" judge --enable --apply`
3. **Anything else, or nothing.** Run exactly:
   `NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" judge --status`

Never put the arguments into the command. Reproduce the command's output in a code block, with no
commentary.
