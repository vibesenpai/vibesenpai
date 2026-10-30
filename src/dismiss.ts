/**
 * Dismissing findings. A dismissal is a record that hides, never deletes: rule findings are re-derived each pass.
 * Rule findings dismiss by subject (docs/contracts.md); judge findings by occurrence; "clear all" per session.
 */

import { findingId, subjectIdOf } from './finding.ts';
import {
  openStore,
  readDismissals,
  type Db,
  type DismissalRow,
  type DismissReason,
  type DismissScope,
} from './store.ts';
import type { Finding } from './types.ts';
import { plural } from './format.ts';

export type Dismissed = {
  subjects: Set<string>;
  findings: Set<string>;
  judged: Set<string>;
};

export function emptyDismissed(): Dismissed {
  return { subjects: new Set(), findings: new Set(), judged: new Set() };
}

export function dismissedFrom(rows: DismissalRow[]): Dismissed {
  const d = emptyDismissed();
  for (const r of rows) {
    if (r.scope === 'subject') d.subjects.add(r.key);
    else if (r.scope === 'finding') d.findings.add(r.key);
    else d.judged.add(r.key);
  }
  return d;
}

/** What is dismissed. An unreadable store hides nothing, so it over-shows rather than hides. */
export function readDismissed(archive: string): Dismissed {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    return dismissedFrom(readDismissals(db));
  } catch {
    return emptyDismissed();
  } finally {
    db?.close();
  }
}

function isDismissed(f: Finding, d: Dismissed): boolean {
  return d.subjects.has(f.subjectId) || d.findings.has(f.id);
}

/** The findings still to show, and how many a dismissal kept back. */
export function withoutDismissed(
  findings: Finding[],
  d: Dismissed,
): { findings: Finding[]; dismissed: number } {
  const kept = findings.filter((f) => !isDismissed(f, d));
  return { findings: kept, dismissed: findings.length - kept.length };
}

/** One thing the person can dismiss. */
export type Candidate = {
  /** The full key a dismissal records. */
  key: string;
  scope: Extract<DismissScope, 'subject' | 'judged'>;
  tier: 'rule' | 'judge';
  dimension: string;
  /** The file for a rule finding; the judge's own name for a judge finding. */
  subject: string;
  /** Per-session finding ids, for a rule finding — what "clear all" records. */
  findingIds: string[];
  sessions: string[];
  occurrences: number;
  /** When the work happened, from the session's own span — never analysis time. */
  lastTs?: string;
  turns?: number[];
  quote?: string;
};

/** Everything not yet dismissed, most recent first, from the store (outlives transcripts). */
export function candidates(db: Db, d: Dismissed): Candidate[] {
  const out: Candidate[] = [];

  // Rule tier, by subject. Project comes from the session row; unrecorded sessions are left out.
  const rule = db
    .prepare(
      `SELECT o.dimension, o.subject, o.session_id, s.project, s.last_ts
       FROM occurrence o JOIN session s ON s.id = o.session_id
       WHERE o.tier = 'rule'`,
    )
    .all();
  const bySubject = new Map<string, Candidate>();
  for (const r of rule) {
    const dimension = String(r['dimension']);
    const subject = String(r['subject']);
    const sessionId = String(r['session_id']);
    const fid = findingId(dimension, sessionId, subject);
    if (d.findings.has(fid)) continue;
    const key = subjectIdOf(dimension, String(r['project']), subject);
    if (d.subjects.has(key)) continue;
    let c = bySubject.get(key);
    if (c === undefined) {
      c = { key, scope: 'subject', tier: 'rule', dimension, subject, findingIds: [], sessions: [], occurrences: 0 };
      bySubject.set(key, c);
    }
    c.occurrences += 1;
    if (!c.findingIds.includes(fid)) c.findingIds.push(fid);
    if (!c.sessions.includes(sessionId)) c.sessions.push(sessionId);
    const ts = r['last_ts'] === null ? undefined : String(r['last_ts']);
    if (ts !== undefined && (c.lastTs === undefined || ts > c.lastTs)) c.lastTs = ts;
  }
  out.push(...bySubject.values());

  // Judge tier, one per occurrence.
  const judge = db
    .prepare(
      `SELECT o.id, o.session_id, o.dimension, o.subject, s.last_ts, e.anchor, e.quote
       FROM occurrence o
       LEFT JOIN evidence e ON e.occurrence_id = o.id
       LEFT JOIN session s ON s.id = o.session_id
       WHERE o.tier = 'judge'`,
    )
    .all();
  const byId = new Map<string, Candidate>();
  for (const r of judge) {
    const key = String(r['id']);
    if (d.judged.has(key)) continue;
    let c = byId.get(key);
    if (c === undefined) {
      const sessionId = String(r['session_id']);
      c = {
        key,
        scope: 'judged',
        tier: 'judge',
        dimension: String(r['dimension']),
        subject: String(r['subject']),
        findingIds: [],
        sessions: [sessionId],
        occurrences: 1,
        turns: [],
        ...(r['last_ts'] === null || r['last_ts'] === undefined ? {} : { lastTs: String(r['last_ts']) }),
      };
      byId.set(key, c);
    }
    const turn = Number(r['anchor']);
    if (Number.isFinite(turn) && !c.turns?.includes(turn)) c.turns?.push(turn);
    if (c.quote === undefined && typeof r['quote'] === 'string') c.quote = r['quote'];
  }
  for (const c of byId.values()) c.turns?.sort((a, b) => a - b);
  out.push(...byId.values());

  return out.sort((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
}

/** The shortest prefix unique among `keys`, never under `min`, like git abbreviations. */
export function shortIds(keys: string[], min = 6): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of keys) {
    let n = min;
    while (n < k.length && keys.some((o) => o !== k && o.startsWith(k.slice(0, n)))) n += 1;
    out.set(k, k.slice(0, n));
  }
  return out;
}

/** What a list of typed ids resolved to. */
export type Resolved<T> = { found: T[]; unknown: string[]; ambiguous: string[] };

/** Match typed ids by prefix. At least 4 characters, so a dismissal never hits the wrong finding by accident. */
export function resolve<T>(items: T[], keyOf: (t: T) => string, typed: string[]): Resolved<T> {
  const r: Resolved<T> = { found: [], unknown: [], ambiguous: [] };
  for (const raw of typed) {
    const id = raw.trim().toLowerCase();
    if (id.length < 4) {
      r.unknown.push(raw);
      continue;
    }
    const hits = items.filter((t) => keyOf(t).startsWith(id));
    if (hits.length === 0) r.unknown.push(raw);
    else if (hits.length > 1) r.ambiguous.push(raw);
    else if (!r.found.includes(hits[0] as T)) r.found.push(hits[0] as T);
  }
  return r;
}

/** The rows that dismiss `c` for `reason`. */
export function dismissalsFor(c: Candidate, reason: DismissReason, at: string): DismissalRow[] {
  // Clearing records each session's finding, so the subject can come back.
  if (reason === 'cleared' && c.tier === 'rule') {
    return c.findingIds.map((key) => ({ key, scope: 'finding' as const, dimension: c.dimension, reason, at }));
  }
  return [{ key: c.key, scope: c.scope, dimension: c.dimension, reason, at }];
}

// Rendering

/** Long enough to recognise the moment, short enough for one line. */
const QUOTE_MAX = 72;
const TURNS_MAX = 3;

/** One finding as a pickable line. */
export function candidateLines(c: Candidate, short: string, currentSessionId?: string): string[] {
  const name = c.dimension.replace(/_/g, ' ');
  const when =
    currentSessionId !== undefined && c.sessions.includes(currentSessionId) && c.sessions.length === 1
      ? 'this session'
      : c.sessions.length > 1
        ? `${c.occurrences} across ${c.sessions.length} sessions`
        : dayOf(c.lastTs);
  if (c.tier === 'judge') {
    const t = c.turns ?? [];
    // Enough to find the moment; the rest is in the report.
    const turns =
      t.length === 0 ? '' : ` · turns ${t.slice(0, TURNS_MAX).join(', ')}${t.length > TURNS_MAX ? ` +${t.length - TURNS_MAX}` : ''}`;
    const head = `${short}  ${name} · ${when}${turns}`;
    return c.quote === undefined ? [head] : [head, `${' '.repeat(short.length + 2)}"${clip(c.quote)}"`];
  }
  const count = c.sessions.length > 1 ? '' : ` · ${c.occurrences}×`;
  return [`${short}  ${name} · ${basename(c.subject)} · ${when}${count}`];
}

/** The listing `/agentsensei:dismiss` puts in front of the person. */
export function renderCandidates(
  cs: Candidate[],
  opts: { currentSessionId?: string; dismissedBefore?: number } = {},
): string {
  const ids = shortIds(cs.map((c) => c.key));
  const lines: string[] = [];
  if (cs.length === 0) {
    lines.push('  Nothing to dismiss.');
  } else {
    lines.push(`  ${plural(cs.length, 'finding')} you can dismiss, most recent first`, '');
    for (const c of cs) {
      for (const l of candidateLines(c, ids.get(c.key) ?? c.key, opts.currentSessionId)) {
        lines.push(`    ${l}`);
      }
    }
  }
  if ((opts.dismissedBefore ?? 0) > 0) {
    lines.push('', `  ${plural(opts.dismissedBefore ?? 0, 'dismissal')} already recorded, not listed`);
  }
  return `${lines.join('\n')}\n`;
}

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= QUOTE_MAX ? flat : `${flat.slice(0, QUOTE_MAX - 1)}…`;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter((x) => x !== '').at(-1) ?? p;
}

function dayOf(ts: string | undefined): string {
  if (ts === undefined) return 'date unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'date unknown';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
