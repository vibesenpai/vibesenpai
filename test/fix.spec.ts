// `fix`, the second output: one recommendation, always with its evidence, and silence where no artifact exists.

import { describe, expect, it } from 'vitest';
import type { Event } from '../src/types.ts';

let seq = 0;
const ev = (o: Partial<Event> & Pick<Event, 'turnType'>): Event =>
  ({ uuid: `u${++seq}`, sessionId: 's1', seq, ts: '2026-01-01T00:00:00.000Z', ...o }) as Event;
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recommend, renderFix, memoryAllowed, MEMORY_WORD_BUDGET, compactionsFor } from '../src/fix.ts';
import type { Standing } from '../src/standing.ts';

const base = (over: Partial<Standing> = {}): Standing => ({
  v: 1,
  computedAt: '2026-10-19T12:00:00.000Z',
  sessions: 7,
  edits: 184,
  tokens: { output: 4_600_000, cacheCreation: 32_100_000 },
  dimensions: [
    {
      dimension: 'edit_retry',
      occurrences: 4,
      sessions: 2,
      files: 3,
      top: { subject: '~/.claude/plans/rosy-seeking-feather.md', occurrences: 2 },
    },
  ],
  wastedTokens: {},
  // `string-not-found` dominates on purpose: `not-read-first` returns a REPORT, so these test the PROMPT path.
  reasons: { 'string-not-found': 3, 'not-read-first': 1 },
  unreadable: 0,
  ...over,
});

describe('fix — exactly one thing', () => {
  it('returns one recommendation, never a list', () => {
    // Six things to fix is nothing to do.
    const r = recommend(base());
    expect(r).toBeDefined();
    expect(Array.isArray(r)).toBe(false);
  });

  it('returns nothing when there is nothing measured', () => {
    expect(recommend(undefined)).toBeUndefined();
    expect(recommend(base({ dimensions: [], reasons: {} }))).toBeUndefined();
  });

  it('always carries the evidence that justifies it', () => {
    // A recommendation without its measurement is advice, which is out of scope.
    const r = recommend(base());
    expect(r?.evidence).toContain('4 edits');
    expect(r?.evidence).toContain('7 sessions');
    expect(r?.because).toMatch(/most common reason/);
  });

  it('names the file it happened in most', () => {
    expect(recommend(base())?.evidence).toContain('rosy-seeking-feather.md');
  });
});

describe('fix — choosing what to recommend', () => {
  it('prefers a fixable dimension over a frequent report-only one', () => {
    // `redundant_call` has no artifact; frequency must not make one up.
    const r = recommend(
      base({
        dimensions: [
          { dimension: 'redundant_call', occurrences: 99, sessions: 5, files: 1 },
          { dimension: 'edit_retry', occurrences: 4, sessions: 2, files: 1 },
        ],
      }),
    );
    expect(r?.dimension).toBe('edit_retry');
    expect(r?.kind).toBe('PROMPT');
  });

  it('reports honestly when the only dimension has no artifact', () => {
    const r = recommend(
      base({ dimensions: [{ dimension: 'redundant_call', occurrences: 9, sessions: 2, files: 1 }] }),
    );
    expect(r?.kind).toBe('REPORT');
    expect(r?.prompt).toBeUndefined();
    expect(r?.because).toMatch(/no artifact/i);
  });

  it('reports rather than guesses when the reason is unrecognised', () => {
    // A reworded harness message must not map to the nearest familiar fix.
    const r = recommend(base({ reasons: { 'something-new': 5 } }));
    expect(r?.kind).toBe('REPORT');
    expect(r?.prompt).toBeUndefined();
  });

  it('breaks a tie stably, so the recommendation does not flip between runs', () => {
    // A tie is broken arbitrarily but stably, so advice does not change on re-run.
    const a = recommend(base())?.prompt;
    const b = recommend(base())?.prompt;
    expect(a).toBe(b);
  });

  it('picks the artifact from the reason, not the dimension', () => {
    const notFound = recommend(base({ reasons: { 'string-not-found': 9 } }));
    const stale = recommend(base({ reasons: { 'stale-read': 9 } }));
    expect(notFound?.prompt).not.toBe(stale?.prompt);
    expect(notFound?.prompt).toMatch(/re-read|context/i);
  });

  it('reports `not-read-first` instead of advising it, because the harness enforces it', () => {
    // The harness already refuses an unread edit, so a rule for it is ceremonial (docs/artifacts.md).
    const r = recommend(base({ reasons: { 'not-read-first': 9 } }));
    expect(r?.kind).toBe('REPORT');
    expect(r?.prompt).toBeUndefined();
    expect(r?.memory).toBeUndefined();
    expect(r?.because).toMatch(/already refuses/i);
  });
});

describe('fix — a judge finding outranks a rule finding when it has a mechanism', () => {
  const judged = (dimension: string, over: Record<string, unknown> = {}) => [{
    sessionId: 's1', dimension, turns: [403], why: 'x', at: 'now',
    quote: 'make sure you delete that prod.env from your memory',
    name: 'Credentials File Left In Memory After Removal Request',
    ...over,
  }] as never;

  it('offers a deterministic mechanism for a constraint violation, not an edit_retry rule', () => {
    // Judged findings outrank a rule for something the harness already enforces.
    const r = recommend(base(), judged('constraint_violation'));
    expect(r?.dimension).toBe('constraint_violation');
    expect(r?.kind).toBe('VERIFY');
    expect(r?.config?.snippet).toMatch(/"Stop"/);
    expect(r?.config?.costs).toMatch(/stop a turn from finishing/);
    expect(r?.prompt).toBeDefined();
  });

  it('points at an external pattern for a false completion claim', () => {
    const r = recommend(base(), judged('inaccurate_self_report'));
    expect(r?.kind).toBe('VERIFY');
    expect(r?.external?.where).toMatch(/verify-gated-completion/);
  });

  it('ranks config above prompt for misread intent, where no gate exists', () => {
    const r = recommend(base(), judged('misread_intent'));
    expect(r?.kind).toBe('CONFIG');
    expect(r?.config?.what).toMatch(/plan mode/);
    expect(r?.config?.costs).toMatch(/slower/i);
    expect(r?.config?.costs).toMatch(/in the way for anything obvious/);
  });

  it('reports `other` and surfaces the descriptors, which is what it is for', () => {
    const r = recommend(undefined, judged('other', { otherDescriptor: 'returned wrong command format' }));
    expect(r?.kind).toBe('REPORT');
    expect(r?.because).toMatch(/returned wrong command format/);
  });

  it('leaves a rule finding alone when the judge has nothing with a mechanism', () => {
    const r = recommend(base(), judged('redundant_call'));
    expect(r?.dimension).toBe('edit_retry');
  });
});

describe('fix — what it renders', () => {
  it('states the measurement before the suggestion', () => {
    const out = renderFix(recommend(base()), 'core');
    expect(out.indexOf('measured')).toBeLessThan(out.indexOf('for this session'));
  });

  it('offers both a session prompt and a CLAUDE.md line', () => {
    const out = renderFix(recommend(base()), 'core');
    expect(out).toContain('for this session');
    expect(out).toContain('CLAUDE.md');
  });

  it('warns that adopting it perturbs the measurement', () => {
    // A dimension under an active brief reads as suppressed, not improved (docs/surfaces.md).
    expect(renderFix(recommend(base()), 'core')).toMatch(/suppressed rather than improved/);
  });

  it('names the preset it chose from', () => {
    // One live detector must not read as the only thing to improve.
    expect(renderFix(recommend(base()), 'core')).toContain('preset "core"');
    expect(renderFix(recommend(base()), 'standard', ['edit_retry'])).toContain('muted: edit_retry');
  });

  it('says so plainly when there is nothing to recommend', () => {
    expect(renderFix(undefined, 'core')).toContain('nothing to recommend');
  });

  it('keeps every line readable in a terminal', () => {
    const lines = renderFix(recommend(base()), 'core').split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(78);
  });

  it('uses no severity word', () => {
    const out = renderFix(recommend(base()), 'core').toLowerCase();
    for (const nag of ['warning', 'error', 'bad', 'wrong', 'failure', 'you should']) {
      expect(out, `must not contain "${nag}"`).not.toContain(nag);
    }
  });
});

describe('fix — the CLAUDE.md budget, which was not checked at all', () => {
  it('offers a rule when there is room', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-fix-budget-'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'a short file.');
    expect(memoryAllowed(dir)).toBe(true);
  });

  it('refuses a rule once the file is past the measured ceiling', () => {
    // Long CLAUDE.md files perform worse (docs/artifacts.md), so `fix` does not append on every run.
    const dir = mkdtempSync(join(tmpdir(), 'as-fix-budget-'));
    writeFileSync(join(dir, 'CLAUDE.md'), Array.from({ length: MEMORY_WORD_BUDGET + 50 }, () => 'word').join(' '));
    expect(memoryAllowed(dir)).toBe(false);
  });

  it('treats a missing CLAUDE.md as room, not as a refusal', () => {
    // A project with no CLAUDE.md is the common case and must not be refused.
    expect(memoryAllowed(mkdtempSync(join(tmpdir(), 'as-fix-none-')))).toBe(true);
  });
});

describe('fix — two non-actions, and which one is worth printing', () => {
  const other = [
    { sessionId: 's1', dimension: 'other', turns: [12], why: 'x', at: 'now', otherDescriptor: 'returned wrong command format' },
    { sessionId: 's2', dimension: 'other', turns: [40], why: 'x', at: 'now', otherDescriptor: 'answered a different question' },
  ] as never;

  it('shows the `other` descriptors rather than a ceremonial edit_retry report', () => {
    // Regression: descriptors were collected but never shown when `Standing` was present.
    const r = recommend(base({ reasons: { 'not-read-first': 9 } }), other);
    expect(r?.dimension).toBe('other');
    expect(r?.because).toMatch(/returned wrong command format/);
    expect(r?.because).toMatch(/answered a different question/);
  });

  it('de-duplicates descriptors, so a repeated shape reads once', () => {
    const dupes = [
      { sessionId: 's1', dimension: 'other', turns: [1], why: 'x', at: 'now', otherDescriptor: 'same shape' },
      { sessionId: 's2', dimension: 'other', turns: [2], why: 'x', at: 'now', otherDescriptor: 'same shape' },
    ] as never;
    const r = recommend(undefined, dupes);
    expect(r?.because.match(/same shape/g)).toHaveLength(1);
  });

  it('still prefers a real mechanism over any report', () => {
    const mixed = [
      ...(other as unknown as Record<string, unknown>[]),
      { sessionId: 's3', dimension: 'constraint_violation', turns: [99], why: 'x', at: 'now' },
    ] as never;
    expect(recommend(base(), mixed)?.kind).toBe('VERIFY');
  });
});

describe('fix — the output explains itself without citing papers at the user', () => {
  it('keeps research figures out of every user-facing string', () => {
    // The research stays in docs/artifacts.md; the user-facing text carries no literature figures.
    const judged = [{ sessionId: 's1', dimension: 'constraint_violation', turns: [9], why: 'x', at: 'now' }] as never;
    const everything = [
      renderFix(recommend(base(), judged), 'core'),
      renderFix(recommend(base(), [{ sessionId: 's1', dimension: 'misread_intent', turns: [9], why: 'x', at: 'now' }] as never), 'core'),
      renderFix(recommend(base(), [{ sessionId: 's1', dimension: 'inaccurate_self_report', turns: [9], why: 'x', at: 'now' }] as never), 'core'),
      renderFix(recommend(base({ reasons: { 'not-read-first': 9 } })), 'core'),
      renderFix(recommend(base({ reasons: { 'string-not-found': 9 } })), 'core'),
    ].join('\n');

    for (const jargon of ['+0.066', '88.3%', '67.0%', '69.4%', '70.8%', '31.8%', '10.5%', '753 rules', '66.7%']) {
      expect(everything).not.toContain(jargon);
    }
    expect(everything).not.toMatch(/\d+\.\d+%/);
  });

  it('still says WHY, in terms of what it means for the user', () => {
    const r = recommend(base(), [{ sessionId: 's1', dimension: 'constraint_violation', turns: [9], why: 'x', at: 'now' }] as never);
    expect(r?.because).toMatch(/checked by Claude Code itself/);
    expect(r?.because).not.toMatch(/\d+%/);
  });
});

describe('fix — a constraint that was compacted away was not ignored', () => {
  const cv = [{ sessionId: 's1', dimension: 'constraint_violation', turns: [2711], why: 'x', at: 'now' }] as never;

  it('changes the recommendation when a compaction preceded the violation', () => {
    // Permissions and hooks survive a compact; an instruction typed into the conversation does not.
    const r = recommend(base(), cv, new Map([['s1', { before: 2, dropped: 904_334 }]]));
    expect(r?.kind).toBe('CONFIG');
    expect(r?.because).toMatch(/may not have been ignored/);
    expect(r?.because).toMatch(/904,000\+/);
    expect(r?.config?.snippet).toMatch(/"matcher": "compact"/);
    expect(r?.config?.snippet).toMatch(/SessionStart/);
  });

  it('gives the ordinary mechanism when no compaction preceded it', () => {
    const r = recommend(base(), cv, new Map());
    expect(r?.kind).toBe('VERIFY');
    expect(r?.because).not.toMatch(/compacted/);
  });

  it('ignores a compaction that happened AFTER the cited turn', () => {
    // Only compactions before the finding can explain it.
    seq = 0;
    const events = [
      ev({ turnType: 'user_prompt' }),
      ev({ turnType: 'assistant_msg' }),
      ev({ turnType: 'assistant_msg', systemKind: 'compaction', compaction: { preTokens: 900_000, postTokens: 1_000 } }),
    ];
    const found = compactionsFor(
      [{ sessionId: 's1', dimension: 'constraint_violation', turns: [1], why: 'x', at: 'now' }] as never,
      () => events,
    );
    expect(found.size).toBe(0);
  });

  it('measures what the last compaction dropped, not the first', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'assistant_msg', systemKind: 'compaction', compaction: { preTokens: 100_000, postTokens: 1_000 } }),
      ev({ turnType: 'assistant_msg', systemKind: 'compaction', compaction: { preTokens: 900_000, postTokens: 2_000 } }),
      ev({ turnType: 'assistant_msg' }),
    ];
    const found = compactionsFor(
      [{ sessionId: 's1', dimension: 'constraint_violation', turns: [3], why: 'x', at: 'now' }] as never,
      () => events,
    );
    expect(found.get('s1')).toEqual({ before: 2, dropped: 898_000 });
  });

  it('treats an unreadable transcript as no overlay, not as an error', () => {
    expect(compactionsFor(cv, () => undefined).size).toBe(0);
  });
});
