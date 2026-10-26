/** Pure text, number and time formatting shared by every surface. No I/O. */

/** `1 file`, `3 files`, `1,204 sessions`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** A local `YYYY-MM-DD HH:MM`, for a person reading it. Falls back to the raw text. */
export function localStamp(isoTs: string): string {
  const t = new Date(isoTs);
  if (Number.isNaN(t.getTime())) return isoTs.slice(0, 16).replace('T', ' ');
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** The UTC calendar day, `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `40 seconds`, `6 minutes`, `3.9 hours`, `25 hours`, `1.7 days`. Coarse on purpose. */
export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins} minutes`;
  const hours = seconds / 3600;
  if (hours < 10) return `${hours.toFixed(1)} hours`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** `1.5k`, `797k`, `17.9M` — an exact count, compacted for a line. Not for estimates; see `approx`. */
export function human(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Compact elapsed time between two timestamps: `42m`, `1h35m`, `3d4h`. */
export function durationOf(from: string | undefined, to: string | undefined): string | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** Shorten a path from the left: the end is what identifies a file. */
export function shortenPath(path: string, max = 68): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

/** Wrap on word boundaries. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line === '') line = w;
    else if (`${line} ${w}`.length <= width) line = `${line} ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line !== '') out.push(line);
  return out;
}
