/**
 * `fix` — the second output.
 *
 * CLAUDE.md allows exactly two: evidence, and something applicable. These tests
 * are mostly about the discipline that keeps the second one honest — one
 * recommendation, always with its evidence, and silence where no artifact
 * exists rather than a manufactured tip.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recommend, renderFix, memoryAllowed, MEMORY_WORD_BUDGET } from '../src/fix.ts';
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
  // `string-not-found` dominates on purpose: `not-read-first` now returns a
  // REPORT, because the harness already refuses an unread edit and a rule
  // asking for it is ceremonial. These cases test the PROMPT path.
  reasons: { 'string-not-found': 3, 'not-read-first': 1 },
  unreadable: 0,
  ...over,
});

describe('fix — exactly one thing', () => {
  it('returns one recommendation, never a list', () => {
    // Behaviour-change research, and the reason `fix` exists rather than a
    // report: a tool that returns six things to fix has returned nothing to do.
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
    // `redundant_call` has no artifact; recommending it would mean inventing
    // one. Frequency must not override that.
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
    // A reworded harness message must not silently map to the nearest
    // familiar fix.
    const r = recommend(base({ reasons: { 'something-new': 5 } }));
    expect(r?.kind).toBe('REPORT');
    expect(r?.prompt).toBeUndefined();
  });

  it('breaks a tie stably, so the recommendation does not flip between runs', () => {
    // 2-2 here. Which one wins is arbitrary; being *stably* arbitrary is what
    // matters, because advice that changes on re-run cannot be followed.
    const a = recommend(base())?.prompt;
    const b = recommend(base())?.prompt;
    expect(a).toBe(b);
  });

  it('picks the artifact from the reason, not the dimension', () => {
    // Two `edit_retry` reasons that need different answers — and one of them
    // needs no answer at all.
    const notFound = recommend(base({ reasons: { 'string-not-found': 9 } }));
    const stale = recommend(base({ reasons: { 'stale-read': 9 } }));
    expect(notFound?.prompt).not.toBe(stale?.prompt);
    expect(notFound?.prompt).toMatch(/re-read|context/i);
  });

  it('reports `not-read-first` instead of advising it, because the harness enforces it', () => {
    // This was the DEFAULT recommendation: "read a file before editing it".
    // The harness already refuses an edit to a path it has not read — which is
    // *why* these were refused — so the rule describes behaviour that already
    // complied. `docs/artifacts.md` measures that category at 66.7% of all
    // rules and calls it ceremonial. Telling the user the harness has it
    // covered is the useful answer.
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
    // The failure this fixes: on a machine whose judge had found two
    // constraint_violations, `fix` reached past them to offer an 11,000-token
    // edit_retry prose rule for something the harness already enforces.
    const r = recommend(base(), judged('constraint_violation'));
    expect(r?.dimension).toBe('constraint_violation');
    expect(r?.kind).toBe('VERIFY');
    expect(r?.config?.snippet).toMatch(/"Stop"/);
    expect(r?.config?.costs).toMatch(/stop a turn from finishing/);
    // The weaker option is still offered, underneath.
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
    // Honest about the cost, in words a user can act on rather than a citation.
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
    // docs/surfaces.md: a dimension under an active brief reads as suppressed,
    // not improved. Handing one over without saying so would make the next
    // report a lie.
    expect(renderFix(recommend(base()), 'core')).toMatch(/suppressed rather than improved/);
  });

  it('names the preset it chose from', () => {
    // One live detector would otherwise read as "there is only one thing you
    // could improve".
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
    // It is a suggestion built from the user's own data, not a verdict on them.
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
    // `docs/artifacts.md`: well-performing files average 300-350 words, past
    // 500 shows diminishing returns, and past 1,000 the correlation with
    // performance goes NEGATIVE. `fix` used to append on every single run,
    // which the same doc calls the mechanism of catastrophic remembering.
    const dir = mkdtempSync(join(tmpdir(), 'as-fix-budget-'));
    writeFileSync(join(dir, 'CLAUDE.md'), Array.from({ length: MEMORY_WORD_BUDGET + 50 }, () => 'word').join(' '));
    expect(memoryAllowed(dir)).toBe(false);
  });

  it('treats a missing CLAUDE.md as room, not as a refusal', () => {
    // The common case is a project with no CLAUDE.md at all. Refusing there
    // would be exactly backwards.
    expect(memoryAllowed(mkdtempSync(join(tmpdir(), 'as-fix-none-')))).toBe(true);
  });
});

describe('fix — two non-actions, and which one is worth printing', () => {
  const other = [
    { sessionId: 's1', dimension: 'other', turns: [12], why: 'x', at: 'now', otherDescriptor: 'returned wrong command format' },
    { sessionId: 's2', dimension: 'other', turns: [40], why: 'x', at: 'now', otherDescriptor: 'answered a different question' },
  ] as never;

  it('shows the `other` descriptors rather than a ceremonial edit_retry report', () => {
    // The first version only reached the judged report when `Standing` was
    // absent, which in practice never happens — so the descriptors were
    // collected and never shown, which defeats the only reason the escape
    // hatch exists.
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
    // The evidence belongs in `docs/artifacts.md` and in the code comments,
    // where it justifies the design to whoever maintains it. A user reading a
    // finding about their own session does not need a literature review, and
    // "+0.066 pts across 753 rules" is a sentence that informs nobody who did
    // not already know what it meant.
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
    // And no bare percentage anywhere, which is the general form of the problem.
    expect(everything).not.toMatch(/\d+\.\d+%/);
  });

  it('still says WHY, in terms of what it means for the user', () => {
    const r = recommend(base(), [{ sessionId: 's1', dimension: 'constraint_violation', turns: [9], why: 'x', at: 'now' }] as never);
    expect(r?.because).toMatch(/checked by Claude Code itself/);
    expect(r?.because).not.toMatch(/\d+%/);
  });
});
