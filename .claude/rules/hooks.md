---
paths:
  - "scripts/hook-*.ts"
  - "hooks/**"
  - "src/breaker.ts"
  - "src/session-block.ts"
  - "src/spawn.ts"
---

# Hooks

- Line one: `AGENTSENSEI_DISABLE=1` returns. Every path exits 0; `hooks.json` adds `|| true` and a
  5-second timeout.
- A hook never waits on analysis. It spawns a detached script (`src/spawn.ts`) and exits.
- Output only as `{"systemMessage": …}` from SessionStart. Never `additionalContext`; never plain
  stdout, which reaches the model.
- The judge lock is taken before spawning and released by the child as the spawner's pid
  (`AGENTSENSEI_JUDGE_LOCK_OWNER`).
- The breaker trips after `TRIP_AFTER` consecutive failures and records why.
