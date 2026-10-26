# Comments

- One or two lines, stating a fact. A file header says what the file is for, in 1–3 lines.
- No `──` banners, no stories of how a bug was found, no quotes, no tombstones for removed code, no
  comment that restates the code.
- When the *why* needs more than a few lines, it belongs in a doc (DECISIONS.md, GRAVEYARD.md,
  docs/*.md). The comment points there in one line, e.g. `// Not a ratio: DECISIONS.md D66.`
- Keep one-line guards for known traps: non-unique tool-call ids, counting usage once per response,
  closing stdin for `execFile`, redaction before every model call, hooks exiting 0.
