---
paths:
  - "scripts/hook-*.ts"
  - "scripts/judge.ts"
  - "scripts/compute-standing.ts"
  - "hooks/**"
  - "src/supervise/**"
  - "src/jobs.ts"
  - "src/session-block.ts"
  - "src/spawn.ts"
---

# Hooks and background jobs

- Line one: `VIBESENPAI_DISABLE=1` returns. Every path exits 0; `hooks.json` adds `|| true` and a
  5-second timeout.
- A hook never waits on analysis. It calls `superviseAll` (`src/jobs.ts`), which heals and starts the
  detached jobs, and exits. Only the Stop hook includes the judge; `tick` needs `--judge` to.
- Output only as `{"systemMessage": …}` from SessionStart. Never `additionalContext`; never plain
  stdout, which reaches the model.
- `src/supervise/` is the harness-agnostic core: it imports only `node:*` and `src/files.ts`
  (a test enforces it). Harness specifics live in `src/jobs.ts` and the hook scripts.
- Every pass runs inside `runJob`: it claims the lease handed over in `VIBESENPAI_LEASE`, heartbeats,
  ends itself at its deadline, and records how it went. A live pid is never reclaimed on time alone.
- Fencing: the judge checks it still holds its lease before every model call and every write.
- Free failures back off and retry for ever; paid failures hold the judge after 3, until
  `judge --enable --apply`. A failing job is stated at session start as one plain fact.
