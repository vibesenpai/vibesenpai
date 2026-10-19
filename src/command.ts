/**
 * Shell command text, reduced to the part that was actually executed.
 *
 * ── Display tier only ───────────────────────────────────────────────────────
 *
 * **No detector may call this.** Reading a command to decide something is a rule
 * over an open space — there are thousands of toolchains and a pattern list can
 * only ever cover the ones we thought of. That is what `StructuralEvent` now
 * forbids at compile time, and `GRAVEYARD.md` records what it cost.
 *
 * This survives because the *skeleton* is a human-readable evidence view. It
 * labels a line; it never produces a finding. A mislabelled line is visible to
 * the person reading it and costs nothing, which is exactly the trade a
 * detection rule cannot make.
 */

/**
 * Remove heredoc bodies, keeping the commands around them.
 *
 * `cat > f <<'EOF' … EOF` becomes `cat > f`. Everything between the marker and
 * its terminator is data being written, not a command being run — and matching
 * a command pattern against data is how a tool reports its own documentation as
 * an event. That is not hypothetical: a detector once flagged
 * `git reset --hard` from inside a doc file being authored with `cat`.
 */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let terminator: string | undefined;

  for (const line of lines) {
    if (terminator !== undefined) {
      // Inside a body: the terminator may be indented when `<<-` was used.
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m !== null) {
      terminator = m[2] as string;
      out.push(line.slice(0, m.index));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * The executable part of a command: heredoc bodies removed, and a trailing
 * `#` comment dropped.
 */
export function executablePart(command: string | undefined): string {
  if (command === undefined) return '';
  return stripHeredocs(command)
    .split('\n')
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
}
