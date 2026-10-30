---
description: Apply the recommended fix, with your yes as the command itself
allowed-tools: Bash(node:*)
---

!`NODE_NO_WARNINGS=1 node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" fix --apply`

If the output above starts with "Apply this fix:", carry out the request under it
exactly, with your normal file tools. Change nothing else. Then say in one line
what you changed.

Otherwise, reproduce the output above and stop.
