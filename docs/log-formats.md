# Claude Code log format

## Schema corrections — the real files contradict the design doc

Fix these in M1 rather than discovering them later. Evidence is in the live transcript at
`~/.claude/projects/-Users-souvikroy-Workspace/e3a3f0d4-*.jsonl`.

1. **A transcript is a tree, not a linear log.** Every record carries `parentUuid`. Rewind and
   compaction create abandoned branches. `turn: number` from the doc is wrong; the parser must
   reconstruct the active leaf path first. Without this, "same file edited repeatedly" double-counts
   edits across branches the user already discarded — a false-flag source that directly attacks
   precision.
2. **`isSidechain` interleaves subagent events.** A parallel fan-out reads the same files many times
   legitimately. Sidechain events must be attributed to their subagent, not the main thread, or
   "reading spiral" fires on every healthy fan-out.
3. **`tool_call` / `tool_result` are not record types.** `tool_use` is a *content block* inside an
   `assistant` message; `tool_result` is a block inside a `user` message. The parser flattens blocks
   into events. Record types actually observed: `user`, `assistant`, `system`, `attachment`,
   `file-history-snapshot`, `mode`, `permission-mode`, `last-prompt`, `atis-latch`.
4. **`attachment` is the most common record type** (31 of 79) and is almost entirely harness noise —
   `hook_success` ×28, plus `skill_listing`, `deferred_tools_delta`. These must be skipped, not
   parsed as events, or every session looks enormously busy. `file-history-snapshot.trackedFileBackups`
   is the cheapest revert/undo signal and should be read rather than reimplemented via diffing.
5. **`usage` was all zeros** in the only session containing assistant turns. Token-based "spend
   without progress" has no verified input on this build — defer it and confirm against SWE-chat's
   `input_tokens`/`output_tokens` columns instead of building blind.

**Normalized `Event`** — aligned to SWE-chat's `conversations` schema so our parser output is directly
comparable to 18k real sessions, and the detectors run unmodified over both:

```ts
type Event = {
  sessionId: string; harness: "claude-code" | "codex" | string;
  uuid: string; parentUuid: string | null;    // tree, not sequence
  seq: number;                                // index along the active leaf path
  isSidechain: boolean; sidechainId?: string;
  ts: string;
  turnType: "user_prompt" | "assistant_msg" | "tool_use" | "tool_result"
          | "queue_operation" | "system";     // SWE-chat turn_type vocabulary
  toolName?: string; toolCallId?: string;
  filePath?: string; command?: string; pattern?: string;
  exitCode?: number; isError?: boolean;
  queueOpSubtype?: string;                    // interrupts
  textSummary?: string;                       // short, redacted
  tokens?: { input?: number; output?: number; cacheRead?: number };
};
```

---

---

*Extracted from the planning document (2026-10-12/15). Reasoning is kept with each
conclusion deliberately — see [DECISIONS.md](../DECISIONS.md) for the index.*
