/**
 * Command text normalisation, shared by every detector that inspects a shell
 * command.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `revert_churn` fired on this, in a real session:
 *
 * ```
 * cat > /tmp/dims-section.md <<'SECTION_END'
 * ... prose that happened to contain the words "git reset --hard" ...
 * SECTION_END
 * ```
 *
 * The command writes a documentation file. The match came from the *heredoc
 * body* — text being written, not a command being run. Any detector grepping a
 * command string has this bug, so the stripping lives in one place.
 */

/**
 * Remove heredoc bodies, keeping the commands around them.
 *
 * `cat > f <<'EOF' … EOF` becomes `cat > f`. Everything between the marker and
 * its terminator is data, and matching a command pattern against data is how a
 * tool ends up reporting its own documentation as an event.
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
 * The executable part of a command: heredoc bodies removed, and anything after
 * a `#` comment on its own dropped.
 */
export function executablePart(command: string | undefined): string {
  if (command === undefined) return '';
  return stripHeredocs(command)
    .split('\n')
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
}
