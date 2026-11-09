---
title: A tour of the pane
description: What each part of the insights pane shows, and what each button does.
---

`/vibesenpai:insights` opens the pane beside the chat. It reads what the background passes
have already worked out, so opening it spends nothing. Where Claude Code cannot draw a pane,
the command prints a text version instead ([`/vibesenpai:insights`](/vibesenpai/commands/insights/)).

The first time it opens it says `Reading your history`, with the seconds so far, and under
that: `The free checks come first. Model reads begin when this turn ends.`

## The header

- **vibesenpai** and how many sessions have been read, as `12/40 sessions read`. While the
  model reads are behind, this is a progress bar instead.
- `updated just now` or `updated 3m ago`, and **↻** (or `r`) to refresh. An open pane checks
  every 30 seconds whether a background pass wrote something new, and after each turn.
- If a background job is failing, one line says so, as `The history pass is retrying: <reason>` or
  `The judge is held: <reason>`.
- Three tabs: **Findings**, **Fixes**, **Health**. `⇥` moves between buttons and `⏎` presses.

## Findings

<!-- screenshot: finding.png -->

### Model reads

Until the model reads have found anything, a card at the top shows their progress: a bar,
`N of M`, and one line that is one of:

- `reading now · about 3 min`
- `Begins when this turn ends.`
- `Today's limit is reached; it continues tomorrow.`
- `Continues in the background when a turn ends.`

When the daily limit sets the pace, it adds `At 2.0M tokens a day, the rest finish tomorrow.`
(or a weekday, or a date). After the first model finding, the card moves into the header as
the progress bar.

### New since you last looked

Up to three findings that arrived since you last opened the pane, each with its kind in front.
"Last looked" is the last time you opened the pane, kept across sessions.

### What went wrong, by kind

One block per kind of finding, most frequent first, each with `N times in M sessions`. The
first block starts open. Inside it, `▸ N findings` lists them, three at a time with `… N more`.
Below the list is the kind's own fix, if it has one.

### A row

A row's headline is **your own words**, in italics: your reaction, if the finding quotes
you, or else the request the agent was answering. Only when neither exists is it the agent's
words or the file involved, and those are never drawn as yours.

Under it: the kind (for new findings), any other kinds it also is (`also overreach`), and
when: `today`, `yesterday` or a date, the session (in a kind's list), then the time of the
first cited turn, or the turn numbers.

### Opening a finding

Pressing a row opens it. The pane reads the conversation around the cited turns from the
transcript, in place, and shows each cited message (marked `▶`) and its neighbours, one line
each: **You** or **Agent**, the time, the words, and how many tool calls there were and how
many failed.

- **Show conversation ▸** shows the same messages in full. **More around this** widens it by
  three messages either side.
- If Claude Code no longer keeps the transcript, the pane says
  `Claude Code no longer keeps this session's transcript.` and shows the words it stored:
  `You asked:` and `The agent said:` or `Quoted:`.

Then, where the finding has them: for the free checks, up to four evidence rows (the time or
turn, what happened, and the file); and these fields:

| field | what |
|---|---|
| **Established** | where the expectation was set before the agent acted: an earlier prompt, a loaded instruction |
| **Why** | the model's one-sentence account of what went wrong |
| **Reasons** | for the free checks, why Claude Code refused each time, as `2× not read first` |
| **Cost** | for the free checks, `1.2k+ tokens written and discarded` |

### The fix

If the finding has a fix, it follows: what kind of change it is
(`A rule the agent reads in every session of this project:`), the change itself, where it
lands (`Added to .claude/rules/vibesenpai.md`), and **Apply**. A finding's own fix, built from
its evidence, is shown when there is one; otherwise its kind's fix is. How Apply works is on
[Fixes and Apply](/vibesenpai/start/fixes/).

A fix that cannot be applied from here shows why instead of Apply:

- `This happened in <project>. Apply it from a session there.`
- `Printed only: a Stop hook can hold a turn open up to 8 times in a row.`

### Your answers

Three buttons sit under an open finding. Each takes effect in the pane at once and offers
**Undo**.

| button | what it records | what the pane says |
|---|---|---|
| **Finding is wrong** | the finding is wrong; it no longer counts | `Hidden. Noted as a wrong finding.` |
| **Not the agent's fault** | it happened, and it was not the agent's mistake; it no longer counts against the agent. Shown only when the quote is yours | `Hidden. It doesn't count against the agent.` |
| **Hide** | nothing about whether it was right; it still counts | `Hidden. It still counts.` |

Hiding never deletes. Every answer is a row in the local store
([Reference](/vibesenpai/reference/#files)).

### Cache rebuilt

When the prompt cache was thrown away and written again from scratch, a **Cache rebuilt**
block says `N times · 1.4M tokens written again`. Opened, it lists the largest three:
`turn N · <session> · N min after the previous request · N written`. There is no
hit rate and no running total ([Cache rebuilds](/vibesenpai/dimensions/cache-rebuilds/)).

### At the bottom

- **Open full report** writes and opens the HTML report
  ([`/vibesenpai:report`](/vibesenpai/commands/report/)).
- **Hide all** hides every finding. They still count, and **Restore all** on the Health tab
  brings them back.

When nothing has been flagged, the tab says `Nothing flagged in N sessions read.` That is a
result, not an unfinished pass.

## Fixes

<!-- screenshot: fixes.png -->

<!-- screenshot: apply.png -->

### Waiting

Every fix on offer in this project that is not in effect yet. Each has a checkbox, who it is
for (`For inaccurate self report.`, or `For overreach, from 3 findings in 2 sessions.`), what
kind of change it is, the change, and where it lands.

Tick several, then **Apply 2** (or `a`) drafts them as one request. With none ticked the tab
says `Select fixes, then apply them as one request.` With nothing waiting it says
`Every fix on offer is applied in this project.`

A rule that was requested but has not been seen loaded yet stays here, with
`Requested Nov 8 · not in effect yet: rules load in a new session, or after /compact`.
A fix that cannot be applied in this project is not listed; it shows under its finding.

### Applied

Each fix that is in effect in this project, most recent first, for example:

```
Applied Nov 8
Before   4 times in 9 sessions
Since    0 times in 3 sessions
```

`Came back in <session>, turn 31` appears once it has happened again. Before and Since are
counts in this project, never rates; [Fixes and Apply](/vibesenpai/start/fixes/) says what
each window holds. With none it says
`None yet. A fix counts as applied once its request is seen in a session.`

## Health

<!-- screenshot: health.png -->

One row each:

| row | what |
|---|---|
| **History pass** | the free checks' background job: `ok`, `running`, `never-ran`, `retrying · <reason>`, or `not run yet` |
| **Judge** | the model reads' job, in the same words plus `held · <reason>`, and `N of M sessions read` |
| **Today** | `637k of 2.0M tokens`, and `budget reached, continues tomorrow` when it is |
| **Spent** | all model reads so far: `11 calls · 576k in · 61k out · $0.08`, with what the dollar figure means for how you are billed |
| **Older** | past sessions beyond the catch-up that have not been read |
| **Model reads** | `on · /vibesenpai:judge off stops them`, or `off · /vibesenpai:judge on` |
| **Dismissed** | how many findings are hidden, with **Restore all** |

The dollar figure is Claude Code's own, at API prices. On a subscription it comes out of your
plan's usage, not a bill.
