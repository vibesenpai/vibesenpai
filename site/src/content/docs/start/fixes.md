---
title: Fixes and Apply
description: What kinds of fix there are, how Apply hands one to the agent, and how you see whether it held.
---

A fix is a change addressed to the agent, built from a finding. vibesenpai never writes a
project file and never sends a prompt. **Apply** drafts a request into your prompt box; you
press Enter, and the agent makes the change under Claude Code's own permission prompt.

## Kinds of fix

| kind | what the pane says | where it lands |
|---|---|---|
| Rule | `A rule the agent reads in every session of this project:` | a line in `.claude/rules/vibesenpai.md`, plus one pointer line in `CLAUDE.md` |
| Permission prompt | `Claude Code asks you before this command runs, in every mode:` | a `permissions.ask` entry such as `Bash(git push *)` in `.claude/settings.local.json` |
| Guard | `Claude Code refuses an edit to this path and tells the agent why:` | a `PreToolUse` hook in `.claude/settings.local.json` that blocks edits to one path outside the project |
| Scoped rule | `A rule the agent reads when it opens these files:` | `.claude/rules/vibesenpai/<id>.md`, loaded only for the files it names |
| Test | `A test that fails when this rule is broken:` | a test or check in the project. The agent shows it to you before adding it |
| Read-only helper | `A helper that answers questions and cannot edit:` | `.claude/agents/ask.md`, an `ask` agent with only Read, Grep and Glob |
| Session instruction | `An instruction for this session only:` | nothing on disk; sent as a prompt |
| Stop-hook check | `A check that runs each time the agent finishes a turn:` | printed only, with no Apply |

The rule line goes to a file of its own, and `CLAUDE.md` gains at most one line:

```
- Rules learned from your own sessions: .claude/rules/vibesenpai.md
```

A Stop-hook check is shown with `Printed only: a Stop hook can hold a turn open up to 8 times
in a row.` It has no Apply until each such hook is bounded and tested.

## Which fix you see

A finding's own fix comes first. It is built from that finding's evidence: a command the
developer said not to run becomes a permission prompt for that command; a write outside the
project becomes a guard on that path; an instruction that was already loaded and broken
anyway becomes a request for a test; an expectation set earlier becomes a rule scoped to the
files written in spite of it. Most findings do not have one
([D67](/vibesenpai/architecture/decisions/)).

Otherwise the kind's fix is shown: one rule, or one session instruction, for that kind of
finding. Some kinds have none,
and the pane then shows no fix. Each kind's fixes are on its page under
[Dimensions](/vibesenpai/dimensions/).

A finding's own fix appears after the next history pass, which runs at most every 10 minutes;
until then its kind's fix is shown.

A fix from a finding in another project is shown with no Apply, and says
`This happened in <project>. Apply it from a session there.` Applied here, it would land in the
wrong repository.

## Apply

1. **Apply** reads your prompt box. If you have typed something, it stops and says
   `Your prompt box has a draft. Clear it, then press Apply again.` It never writes over a
   draft.
2. It drafts the request into the box. The pane says
   `Fix drafted in your prompt box. Press Enter to apply it.`
3. Your Enter is the yes. The agent makes the change, under Claude Code's own permission
   prompt.

If there is no prompt box, or it will not take the request, the request goes to your
clipboard and the pane says so. If the clipboard refuses too, the pane shows the request to
copy by hand.

On the Fixes tab you can tick several fixes and apply them as one request.

## The request

A drafted request for the rule above reads:

```
Add this line to .claude/rules/vibesenpai.md (create the file if it is missing; skip a line already there):
- Never report work as done or passing unless a command in this session shows it; quote the output.
Then, if CLAUDE.md does not already point to that file, add this line to it:
- Rules learned from your own sessions: .claude/rules/vibesenpai.md
(vibesenpai fix 3704ae)
```

Every request ends with the marker `(vibesenpai fix <id>)`. It is how a fix is dated: when the
background pass sees the marker in a prompt you sent, that fix counts as applied in that
project from that moment. No button marks a fix applied; only the request reaching a session
does. The id comes from what the fix is for, not its wording, so a reworded fix keeps its
history.

## Waiting and Applied

| state | means |
|---|---|
| **Waiting** | on offer in this project and not in effect yet |
| **Requested, not in effect yet** | the marker was seen, but the rule has not been seen loaded. The pane says `not in effect yet: rules load in a new session, or after /compact` |
| **Applied** | in effect: for a rule, seen loaded in a session; for anything else, requested |

Claude Code loads rules when a session starts or after `/compact`; there is no command that
reloads them. So a rule counts from the first time its text is seen loaded, not from when it
was requested. A rule that was requested and never loaded may have been declined at the
permission prompt, so it stays on offer with **Apply again**.

## Before, Since and Came back

Each applied fix shows two windows in the project it was applied in. The numbers below are an example:

```
Before   4 times in 9 sessions
Since    0 times in 3 sessions
```

- These are **counts in one project, never rates**.
- **Before** counts sessions before the fix took effect; **Since** counts sessions after.
- The session the fix was requested in, and a session the rule first loaded into part-way
  through, are in neither window: part of each is before and part after.
- For a model-read kind, only sessions the model has read are counted.
- A finding's own fix counts its own constraint (the same command, the same path). A fix
  that cannot be matched that precisely counts every finding of its kind.

**Came back** names the first session, and the turn, where it happened again after the fix.
