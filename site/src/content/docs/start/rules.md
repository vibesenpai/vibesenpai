---
title: Rules
description: "The Rules tab: the instruction files Claude Code loaded in a project, memory that does not load by itself, and facts about the files."
---

The Rules tab shows what Claude was given in a project, and what it never sees. It is built from
your transcripts and the files on disk. No model reads it and nothing is sent.

## What Claude Code loads

Claude Code records each instruction file it loads in the session's transcript, so the tab knows
exactly what a session was given:

| when | what loads |
|---|---|
| a session starts | `CLAUDE.md` in the folder and every folder above it, `~/.claude/CLAUDE.md`, `.claude/rules/` files without `paths:`, and the memory index `MEMORY.md` |
| later in the session | a subfolder's `CLAUDE.md` when Claude works there, and a rule with `paths:` when Claude reads or edits a matching file |
| only when Claude opens it | each memory file listed in `MEMORY.md` |

Memory is kept per folder. A session started in `~/work/app` loads `~/work/app`'s memory index, and
never the memory of `~/work`, even though it loads `~/work/CLAUDE.md`.

## What the tab shows

| group | what |
|---|---|
| **Every session** | files loaded when a session starts, with their kind and length |
| **Sometimes** | files loaded later, and in how many sessions |
| **Written, but not loaded here** | memory of a parent folder. A memory saved as a rule (`type: feedback`) is marked **rule** |
| **Loaded only when Claude opens them** | this project's memory files |
| **Worth a look** | the same line in two files, or a link to a file that does not exist |

Open a file to see its current lines. The text is read from disk when the tab draws it, and is
never stored; only the paths and how often each file loaded are kept, in `store.db`.

When rules you wrote do not load in a project, the session-start message says how many:

```
6 rules you wrote do not load in this project. For more info open the "Rules" tab in /vibesenpai:insights
```

## Related

| | |
|---|---|
| [A tour of the pane](/vibesenpai/start/pane/) | every tab |
| [Fixes and Apply](/vibesenpai/start/fixes/) | the rules a fix adds, and where they land |
