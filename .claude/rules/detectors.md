---
paths:
  - "src/detect/**"
  - "src/parsers/**"
  - "src/types.ts"
  - "scripts/measure-dimensions.ts"
---

# Detectors and parsers

- `StructuralEvent = Omit<Event, 'command' | 'pattern' | 'textSummary'>`. Detectors get only this,
  so reading command text in a detector is a build failure. Text is an open space: a rule over it
  cannot even say what it missed.
- **A harness string may name a finding; it may never produce one.** `src/detect/labels.ts` maps the
  harness's own reasons to words, and the runner applies it after a detector has produced a
  candidate. Reword a message and the finding still fires, as "reason unknown".
- The format has no error codes, but it has an envelope, and the envelope is structure. The parser
  records who rejected a call in `Event.failureKind`: the tool (`<tool_use_error>`), the person
  ("The user doesn't want to proceed"), a cascade ("Sibling tool call errored"), or the person's own
  hook (`PreToolUse:… hook error`). Only the tool is agent waste.
- Tool-call ids are **not unique** within a transcript; pair a result with the nearest call before it.
- Count `usage` **once per response** (`oncePerResponse`): one response is split across records that
  repeat the same `usage`.
- Scope is a property of the detector. `window` is what a model can afford to read; `thread` is one
  actor in order; `session` is anything, by anyone; `project` (history) is declared but refused.
  Both shipped detectors are `session`-scoped. A per-window rule would have called 81% of verified
  edits unverified, because the verifying command sat in a later window.
- A span ends at the next user prompt: a new instruction is a new request.
- Harness coupling belongs in the harness-specific parser, never in a detector.
