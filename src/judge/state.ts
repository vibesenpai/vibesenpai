/**
 * The judge's own state: whether it may run, what it has judged, what it spent.
 * Kept out of `Config`, which resolves user settings with provenance; a ledger has none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JUDGE_DIMENSIONS, type JudgeFinding } from './prompt.ts';
import type { Established } from './lookback.ts';
import {
  addSpend,
  advanceLedger,
  openStore,
  partCursors,
  putEvidence,
  putOccurrences,
  readDismissals,
  readSpend,
  setPartCursor,
  skippedSessions,
  transact,
  unmarkSkipped,
  type Db,
} from '../store.ts';
import { createHash } from 'node:crypto';
import { writeJson } from '../files.ts';

type JudgeSettings = {
  enabled: boolean;
  /** Default Haiku, on cost (~1/38 the default model); quality is the gold set's question. */
  model: string;
  /** Turns of new transcript before the live session is judged again. */
  cadence: number;
  /** A batch larger than this is split rather than sent. */
  maxBatchTokens: number;
  /** Batches a pass sends at once. */
  concurrency: number;
  /** Require misreads and violations to cite an earlier source (src/judge/lookback.ts). */
  lookback: boolean;
};

export const DEFAULT_SETTINGS: JudgeSettings = {
  // On by default: `/plugin install` is the consent. See .claude/rules/judge.md.
  enabled: true,
  model: 'haiku',
  // ~50 turns, so a long session is judged a handful of times; each call costs ~26k tokens overhead.
  cadence: 50,
  maxBatchTokens: 60_000,
  // Calls share the measured session's quota; a larger burst risks failing all at once on a rate limit.
  concurrency: 3,
  // A misread or violation must cite an earlier source; a suggestion is not a mistake. See src/judge/lookback.ts.
  lookback: true,
};

/** A stored judge finding: what the model returned, plus when, and its occurrence id once read back. */
export type JudgedFinding = Omit<JudgeFinding, 'quote'> & {
  /** The occurrence id, as stored. Present on read-back; it is what a dismissal names. */
  id?: string;
  /** When it was judged. */
  at: string;
  quote?: string;
};

export type JudgeState = {
  settings: JudgeSettings;
  /** How far each session has been judged, as a byte offset: a live session keeps growing. */
  ledger: Record<string, number>;
  findings: JudgedFinding[];
  /** Findings hidden by a dismissal, counted so a surface can say so. */
  dismissed?: number;
  /** Cumulative judge spend, in tokens, never dollars. */
  usage: { calls: number; inputTokens: number; outputTokens: number };
  /** Set when the store could not be read, so a surface does not present zeros as fact. */
  storeUnreadable?: boolean;
  /** Sessions no packet can hold. Not an error; see `markSkipped` in `src/store.ts`. */
  skipped?: string[];
  /** Where reading stopped inside a turn too large for one packet: its seq and chars sent. */
  parts?: Record<string, { seq: number; chars: number }>;
};

export function emptyState(): JudgeState {
  return {
    settings: { ...DEFAULT_SETTINGS },
    ledger: {},
    findings: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Settings have their own file, and no producer opens it, so a pass can never rewrite a user's `enabled: false`.
 */
function settingsPath(archive: string): string {
  return join(archive, 'judge-settings.json');
}

/** Settings from their file, progress from the store. Never throws; a corrupt file reads as defaults. */
export function readJudgeState(
  archive: string,
  opts: { dismissed?: 'hide' | 'include' } = {},
): JudgeState {
  return {
    settings: readSettings(archive),
    ...readProgress(archive, opts.dismissed ?? 'hide'),
  };
}

/** Just the consent half. Cheap, and the only part a hook needs synchronously. */
function readSettings(archive: string): JudgeSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(archive), 'utf8')) as Partial<JudgeSettings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Write the settings only. The one user-initiated write; a background pass never touches it. */
export function writeSettings(archive: string, settings: JudgeSettings): boolean {
  try {
    writeJson(settingsPath(archive), settings);
    return true;
  } catch {
    return false;
  }
}

/** The ledger, findings and spend, read out of the store. */
function readProgress(
  archive: string,
  dismissed: 'hide' | 'include',
): Omit<JudgeState, 'v' | 'settings'> {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    const spend = readSpend(db);
    const ledger: Record<string, number> = {};
    for (const row of db.prepare('SELECT session_id, judged_bytes FROM ledger').all()) {
      ledger[String(row['session_id'])] = Number(row['judged_bytes']);
    }
    const skipped = skippedSessions(db).map((r) => r.sessionId);
    const parts = partCursors(db);
    // The judge still sees dismissed findings, so it does not re-report them under a new id.
    const all = readJudgedFindings(db);
    const hidden =
      dismissed === 'include'
        ? new Set<string>()
        : new Set(readDismissals(db).filter((d) => d.scope === 'judged').map((d) => d.key));
    const findings = all.filter((f) => f.id === undefined || !hidden.has(f.id));
    return {
      ledger,
      findings,
      ...(all.length > findings.length ? { dismissed: all.length - findings.length } : {}),
      usage: { calls: spend.calls, inputTokens: spend.tokensIn, outputTokens: spend.tokensOut },
      ...(skipped.length === 0 ? {} : { skipped }),
      ...(Object.keys(parts).length === 0 ? {} : { parts }),
    };
  } catch {
    // Never throw (Principle Zero), but flag it: an unreadable store is not an empty one.
    return {
      ledger: {},
      findings: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      storeUnreadable: true,
    };
  } finally {
    db?.close();
  }
}

/** Judge findings reassembled from the fact table: one row per anchored turn, grouped by occurrence id. */
function readJudgedFindings(db: Db): JudgedFinding[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.session_id, o.dimension, o.secondary_dimensions, o.reason, o.at, e.anchor, e.kind, e.quote
       FROM occurrence o LEFT JOIN evidence e ON e.occurrence_id = o.id
       WHERE o.tier = 'judge' ORDER BY o.at DESC`,
    )
    .all();

  const by = new Map<string, JudgedFinding & { turns: number[] }>();
  for (const r of rows) {
    const id = String(r['id']);
    let f = by.get(id);
    if (f === undefined) {
      f = {
        id,
        sessionId: String(r['session_id']),
        dimension: String(r['dimension']) as JudgedFinding['dimension'],
        turns: [],
        why: r['reason'] === null ? '' : String(r['reason']),
        at: String(r['at']),
        ...secondaryOf(r['secondary_dimensions']),
      };
      by.set(id, f);
    }
    if (r['kind'] === 'established') {
      try {
        f.established = JSON.parse(String(r['quote'])) as Established;
      } catch {
        // An unreadable source is no source; the finding itself stands.
      }
      continue;
    }
    if (f.quote === undefined && r['quote'] !== null && r['quote'] !== undefined) f.quote = String(r['quote']);
    const seq = Number(r['anchor']);
    if (Number.isFinite(seq)) f.turns.push(seq);
  }
  return [...by.values()];
}

function secondaryOf(v: unknown): { secondaryDimensions?: JudgedFinding['dimension'][] } {
  if (typeof v !== 'string') return {};
  try {
    const a = JSON.parse(v) as unknown;
    const dims = Array.isArray(a) ? a.filter((d): d is JudgedFinding['dimension'] => JUDGE_DIMENSIONS.includes(d)) : [];
    return dims.length > 0 ? { secondaryDimensions: dims } : {};
  } catch {
    return {};
  }
}

/**
 * Record a pass's findings and watermark in one transaction; the watermark means "we have results for these bytes".
 * Never writes settings or spend.
 */
export function recordPass(
  archive: string,
  findings: JudgedFinding[],
  offsets: Map<string, number>,
  /** Progress inside an oversized turn, committed with the findings. `undefined` means finished. */
  parts: Map<string, { seq: number; chars: number } | undefined> = new Map(),
): boolean {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    transact(db, () => {
      if (findings.length > 0) {
        putOccurrences(
          db as Db,
          findings.map((f) => ({
            id: judgedFindingId(f),
            sessionId: f.sessionId,
            dimension: f.dimension,
            tier: 'judge' as const,
            subject: f.name ?? f.dimension,
            confidence: f.confidence ?? 'likely',
            reason: f.why,
            at: f.at,
            ...(f.secondaryDimensions === undefined ? {} : { secondaryDimensions: f.secondaryDimensions }),
          })),
        );
        putEvidence(
          db as Db,
          findings.flatMap((f) => [
            ...f.turns.map((t) => ({
              occurrenceId: judgedFindingId(f),
              anchor: String(t),
              // The judge cites turn numbers, validated by its quote. Rule findings use uuid (D24).
              kind: 'turn' as const,
              ...(f.quote === undefined ? {} : { quote: f.quote }),
            })),
            // Where the expectation was set (lookback), as one more row; redacted like every quote.
            ...(f.established === undefined
              ? []
              : [{ occurrenceId: judgedFindingId(f), anchor: 'established', kind: 'established' as const, quote: JSON.stringify(f.established) }]),
          ]),
        );
      }
      for (const [id, off] of offsets) {
        advanceLedger(db as Db, id, off);
        unmarkSkipped(db as Db, id);
      }
      for (const [id, cursor] of parts) {
        setPartCursor(db as Db, id, cursor);
        unmarkSkipped(db as Db, id);
      }
    });
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Record what a call cost, outside any transaction, since the spend happened regardless. */
export function recordSpend(
  archive: string,
  delta: { calls?: number; tokensIn?: number; tokensOut?: number },
): void {
  let db: Db | undefined;
  try {
    db = openStore(archive);
    addSpend(db, delta);
  } catch {
    // Never worth failing a pass over.
  } finally {
    db?.close();
  }
}

/** Content-hashed id, so a retried pass upserts instead of duplicating. */
function judgedFindingId(f: JudgedFinding): string {
  return createHash('sha256')
    .update(`judge\0${f.sessionId}\0${f.dimension}\0${f.quote ?? f.why.slice(0, 120)}`)
    .digest('hex')
    .slice(0, 16);
}

/** Findings per dimension across the store, for the summary surfaces. */
export function tallyByDimension(state: JudgeState): { dimension: string; count: number }[] {
  const by = new Map<string, number>();
  for (const f of state.findings) by.set(f.dimension, (by.get(f.dimension) ?? 0) + 1);
  return [...by].map(([dimension, count]) => ({ dimension, count }));
}

/** Has the one-time spend disclosure been shown? A marker file, so a store rebuild cannot re-show it. */
export function hasDisclosed(archive: string): boolean {
  return existsSync(join(archive, 'disclosed'));
}

export function markDisclosed(archive: string): void {
  try {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, 'disclosed'), new Date().toISOString(), { mode: 0o600 });
  } catch {
    // Worst case the notice shows twice. Never worth failing a command over.
  }
}

/** Findings for one session, newest first. */
export function findingsFor(state: JudgeState, sessionId: string): JudgedFinding[] {
  return state.findings
    .filter((f) => f.sessionId === sessionId)
    .sort((a, b) => b.at.localeCompare(a.at));
}
