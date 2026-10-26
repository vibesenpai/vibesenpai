// The renderer is the product surface; these tests mostly pin what it must NOT print (no score, no total).

import { describe, expect, it } from 'vitest';
import { parse } from '../src/parsers/index.ts';
import {
  activeDuration,
  caveatFor,
  firstSentence,
  headlineFor,
  render,
  renderCompaction,
  renderFinding,
  renderJudged,
  renderRebuilds,
  spanOf,
} from '../src/render.ts';
import { materialise } from '../src/finding.ts';
import { durationOf, shortenPath } from '../src/format.ts';
import { sessionStats } from '../src/stats.ts';
import type { Denominators } from '../src/detect/index.ts';
import type { Event, Finding } from '../src/types.ts';

const zeros: Denominators = {
  turnCount: 0,
  editCount: 0,
  toolCallCount: 0,
  failedCallCount: 0,
  unclassifiedTouchCount: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
};

let seq = 0;
const ev = (over: Partial<Event> & Pick<Event, 'turnType'>): Event => {
  seq += 1;
  return {
    sessionId: 's1',
    harness: 'claude-code',
    uuid: over.uuid ?? `u${seq}`,
    parentUuid: null,
    seq: over.seq ?? seq,
    isSidechain: false,
    ...over,
  } as Event;
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  ...materialise({
    candidate: {
      dimension: 'edit_retry',
      subject: '/repo/src/api.ts',
      evidence: [
        { uuid: 'a', sessionId: 's1', seq: 10 },
        { uuid: 'b', sessionId: 's1', seq: 11 },
        { uuid: 'c', sessionId: 's1', seq: 12 },
      ],
      anchors: [{ uuid: 'b', sessionId: 's1', seq: 11 }],
      confidence: 'certain',
      method: 'RULE',
      polarity: 'lower-is-better',
      requiresOutcome: false,
    },
    sessionId: 's1',
    project: 'proj',
    now: '2026-10-19T00:00:00.000Z',
  }),
  ...over,
});

describe('render — what it must never print', () => {
  it('prints no score, total or grade', () => {
    const out = render({
      findings: [finding({ reasons: { 'not-read-first': 3 } })],
      denominators: { ...zeros, editCount: 40, tokens: { input: 1, output: 1000, cacheRead: 9, cacheCreation: 12000 } },
      sessionId: 'abcdef1234',
      events: [],
    });
    for (const banned of ['score', 'grade', '/100', 'out of', 'total:']) {
      expect(out.toLowerCase(), `must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it('prints no cache total and no ratio, however large the numbers', () => {
    // Cache figures appear only beside a flag: DECISIONS.md D66.
    const out = render({
      findings: [],
      denominators: { ...zeros, tokens: { input: 10, output: 50_000, cacheRead: 9_000_000, cacheCreation: 4_000_000 } },
      sessionId: 'abcdef1234',
      events: [],
    });
    expect(out).not.toMatch(/9\.0M|9,000,000|4\.0M|4,000,000|cacheRead|hit rate|your usual|\d+x what/i);
  });

  it('uses no imperative verb in the subject line', () => {
    const line = renderFinding(finding())[0] as string;
    for (const nag of ['fix', 'stop', 'avoid', 'should', 'must']) {
      expect(line.toLowerCase()).not.toContain(nag);
    }
  });
});

describe('render — evidence is checkable in place', () => {
  it('says what happened at each cited turn, not just its number', () => {
    const edit = ev({ turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/src/api.ts', uuid: 'a', seq: 10 });
    const refused = ev({
      turnType: 'tool_result', uuid: 'b', seq: 11, isError: true, failureKind: 'tool',
      textSummary: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    });
    const retry = ev({ turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/src/api.ts', uuid: 'c', seq: 12 });
    const out = render({
      findings: [finding({ reasons: { 'not-read-first': 1 } })],
      denominators: { ...zeros, editCount: 2 },
      sessionId: 'abcdef1234',
      events: [edit, refused, retry],
    });
    // Turn number and what happened, in aligned columns, without a repeated `turn ` prefix.
    expect(out).toContain('10  Edit');
    expect(out).toContain('refused');
    // The header names the subject, so evidence rows do not repeat the path.
    expect(out.match(/\/repo\/src\/api\.ts/g)).toHaveLength(1);
    expect(out).toContain('refused');
    expect(out).toContain('not-read-first');
  });

  it('prints (reason unknown) rather than implying there was none', () => {
    const out = renderFinding(finding()).join('\n');
    expect(out).toContain('(reason unknown)');
  });
});

describe('render — an empty result is not an unanalysed one', () => {
  it('distinguishes "nothing found" from "nothing to analyse"', () => {
    // The denominator on the session line says "nothing" once, not three times.
    const noEdits = render({ findings: [], denominators: zeros, sessionId: 's', events: [] });
    expect(noEdits).toContain('0 edits');

    const clean = render({ findings: [], denominators: { ...zeros, editCount: 155 }, sessionId: 's', events: [] });
    expect(clean).toContain('155 edits');
  });

  it('names muted dimensions, so silence is never mysterious', () => {
    const out = render({
      findings: [], denominators: { ...zeros, editCount: 3 }, sessionId: 's', events: [],
      muted: ['edit_retry'],
    });
    expect(out).toContain('muted: edit_retry');
  });

  it('surfaces the unclassified-touch gap instead of hiding it', () => {
    const out = render({
      findings: [], denominators: { ...zeros, editCount: 3, unclassifiedTouchCount: 4 },
      sessionId: 's', events: [],
    });
    expect(out).toContain('could not be classified');
  });
});

describe('render — timestamps and spans', () => {
  it('ignores records with no usable timestamp', () => {
    // file-history-snapshot records carry no timestamp; one must not become the session start.
    const span = spanOf([
      ev({ turnType: 'system', systemKind: 'file-history' }),
      ev({ turnType: 'user_prompt', ts: '2026-10-19T10:00:00.000Z' }),
      ev({ turnType: 'user_prompt', ts: '2026-10-19T11:30:00.000Z' }),
    ]);
    expect(span.first).toBe('2026-10-19T10:00:00.000Z');
    expect(durationOf(span.first, span.last)).toBe('1h30m');
  });

  it('reads a resumed session in days, not hours', () => {
    expect(durationOf('2026-10-12T00:00:00.000Z', '2026-10-19T06:00:00.000Z')).toBe('7d6h');
  });

  it('returns undefined rather than 0m when the span is unknowable', () => {
    expect(durationOf(undefined, '2026-10-19T00:00:00.000Z')).toBeUndefined();
    expect(spanOf([ev({ turnType: 'system' })]).first).toBeUndefined();
  });
});

describe('render — a digest subject gets a readable headline', () => {
  it('substitutes the command while keeping the digest it is keyed on', () => {
    // Detectors name a Bash run by id; the display tier may read the command for the headline.
    const call = ev({
      turnType: 'tool_use', toolName: 'Bash', uuid: 'a', seq: 10,
      command: 'npx tsc --noEmit 2>&1 | head -30',
    });
    const f = finding({ subject: 'Bash #8e0f94' });
    const out = headlineFor(f, new Map([[call.uuid, call]]));
    expect(out).toContain('npx tsc --noEmit');
    expect(out).toContain('#8e0f94');
  });

  it('leaves a path subject alone', () => {
    expect(headlineFor(finding(), new Map())).toBe('/repo/src/api.ts');
  });

  it('keeps the digest when no cited turn carries a command', () => {
    expect(headlineFor(finding({ subject: 'TodoWrite #475905' }), new Map())).toBe('TodoWrite #475905');
  });
});

describe('shortenPath keeps the identifying end', () => {
  it('keeps the tail, which is what names the file', () => {
    const long = '/Users/x/very/deeply/nested/project/packages/web/src/components/Thing.tsx';
    const out = shortenPath(long, 30);
    expect(out.endsWith('Thing.tsx')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('leaves a short path alone', () => {
    expect(shortenPath('src/a.ts')).toBe('src/a.ts');
  });
});

describe('render — the confidence badge is gone, the caveat is not', () => {
  it('says nothing for a rule that is certain', () => {
    // Every live detector emits `certain`, so a confidence badge says nothing.
    expect(caveatFor(finding({}))).toBe('');
  });

  it('explains a rule that is merely close', () => {
    const c = caveatFor(finding({ confidence: 'high' }));
    expect(c).toContain('clipped');
    expect(c).not.toContain('high');
  });

  it('marks a model-flagged finding, which is the rule CLAUDE.md cares about', () => {
    expect(caveatFor(finding({ method: 'JUDGE' }))).toContain('flagged by a model');
    expect(caveatFor(finding({ method: 'JUDGE', confidence: 'low' }))).toContain('low');
  });

  it('never prints "certain" anywhere in a report', () => {
    const out = render({
      findings: [finding({})],
      denominators: { ...zeros, editCount: 2 },
      sessionId: 'abcdef1234',
      events: [],
    });
    expect(out).not.toContain('certain');
  });
});

describe('render — CONTEXT states compaction without judging it', () => {
  const statsWith = (count: number, measured: { seq: number; preTokens: number; postTokens: number }[]) => ({
    rewritten: [],
    compactions: {
      count,
      dropped: measured.reduce((n, m) => n + (m.preTokens - m.postTokens), 0),
      measured,
    },
  });

  it('says nothing at all when the session never compacted', () => {
    expect(renderCompaction(statsWith(0, []) as never)).toEqual([]);
  });

  it('reports the harness figures, with no verb and no threshold', () => {
    const out = renderCompaction(
      statsWith(1, [{ seq: 1745, preTokens: 1_000_333, postTokens: 31_492 }]) as never,
    ).join('\n');
    expect(out).toContain('summarised');
    expect(out).toContain('summarised once');
    // No per-turn rows: the fact that it happened is the only actionable part.
    expect(out).toContain('969k');
    expect(out).not.toContain('1745');
    // Stated, not judged: no imperative, no severity word.
    expect(out).not.toMatch(/should|too |avoid|warning|reduce/i);
  });

  it('counts a compaction that carries no figures rather than hiding it', () => {
    // The older `summary` record has no token counts; two compactions must not merge into one.
    const out = renderCompaction(
      statsWith(3, [{ seq: 10, preTokens: 900, postTokens: 100 }]) as never,
    ).join('\n');
    expect(out).toContain('summarised 3 times');
    expect(out).toContain('summarised 3 times');
  });
});

describe('render — model findings are kept visibly apart', () => {
  it('labels the section so a reader knows what kind of claim it is', () => {
    // CLAUDE.md: never blur "flagged by rule" and "flagged by a model".
    const out = renderJudged(
      [{ dimension: 'inaccurate_self_report', turns: [412, 460], why: 'said green, 412 failed' }],
      0,
    ).join('\n');
    // The marker is per row, so mixed sections still tell model claims from rule ones.
    expect(out).toContain('flagged by a model');
    expect(out).toContain('inaccurate_self_report');
    expect(out).toContain('412, 460');
  });

  it('states the lag, because a judged finding is as old as the last pass', () => {
    // With no findings and a full count, no pass has happened; do not imply one.
    expect(renderJudged([], 23).join('\n')).toContain('Nothing flagged in this session yet');
  });

  it('says nothing at all when there is nothing and no lag', () => {
    expect(renderJudged([], 0)).toEqual([]);
  });

  it('does not look broken when it simply has not run yet', () => {
    // Tone: a never-read session must not look broken. Queue counts belong to the `Analysis` block.
    const out = renderJudged([], 5).join('\n');
    expect(out).toContain('Nothing flagged in this session yet');
    expect(out).not.toMatch(/fail|error|behind|stale/i);
  });
});

describe('the lead line', () => {
  // The first line is the whole pitch, so it has rules.
  const d = (over = {}) => ({
    turnCount: 10, editCount: 2260, toolCallCount: 50, failedCallCount: 0,
    unclassifiedTouchCount: 0,
    tokens: { input: 0, output: 1000, cacheRead: 0, cacheCreation: 5000 },
    ...over,
  });

  it('states what was found before naming the session', () => {
    // The news comes first, not an id and counts.
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
      judged: { findings: [{ dimension: 'misread_intent', turns: [12], why: 'x' }], unjudgedTurns: 0 },
    });
    const body = out.split('\n').filter((l) => l.trim() !== '');
    expect(body[0]).toContain('1 finding');
    expect(body[1]).toContain('This session');
    expect(body[1]).toContain('This session');
    // The session id is gone from the lead; `--session` still accepts it.
    expect(out).not.toContain('abcdef12');
  });

  it('counts both tiers in the lead', () => {
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
      judged: {
        findings: [
          { dimension: 'misread_intent', turns: [12], why: 'x' },
          { dimension: 'overreach', turns: [14], why: 'y' },
        ],
        unjudgedTurns: 0,
      },
    });
    expect(out).toContain('2 findings');
    expect(out).not.toMatch(/no findings across/);
  });

  it('still says nothing was found when neither tier fired', () => {
    // A clean session must still read as a real statement (PLAN.md:21).
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
    });
    expect(out).toContain('no findings across 2260 edits');
  });

  it('uses real plurals, never the "(s)" form', () => {
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
      judged: { findings: [{ dimension: 'overreach', turns: [1], why: 'y' }], unjudgedTurns: 0 },
    });
    expect(out.split('\n')[1]).toContain('1 finding');
    expect(out.split('\n')[1]).not.toContain('finding(s)');
  });
});

describe('duration is time worked, not time elapsed', () => {
  // Active time, not wall-clock: hours a tab sat idle are not time spent.
  const at = (iso: string) => ({ ts: iso }) as unknown as Parameters<typeof activeDuration>[0][number];

  it('drops a gap nobody was present for', () => {
    const out = activeDuration([
      at('2026-10-23T06:14:00.000Z'),
      at('2026-10-23T06:24:00.000Z'),
      at('2026-10-23T18:30:00.000Z'), // twelve hours later
      at('2026-10-23T18:40:00.000Z'),
    ]);
    expect(out, 'two ten-minute bursts are twenty minutes of work').toBe('20m');
  });

  it('keeps a long think, which is work', () => {
    // Generous threshold: over-counting a long think costs a minute; under-counting costs credibility.
    const out = activeDuration([
      at('2026-10-23T06:00:00.000Z'),
      at('2026-10-23T06:29:00.000Z'),
    ]);
    expect(out).toBe('29m');
  });

  it('says so rather than rounding a short session to zero', () => {
    // Under a minute must not render as `0m`.
    expect(
      activeDuration([at('2026-10-23T06:00:00.000Z'), at('2026-10-23T06:00:20.000Z')]),
    ).toBe('under a minute');
  });

  it('has nothing to say about a single event', () => {
    expect(activeDuration([at('2026-10-23T06:00:00.000Z')])).toBeUndefined();
    expect(activeDuration([])).toBeUndefined();
  });
});

describe('the harness says when a turn is not a human speaking', () => {
  // Regression: `isMeta: true` user records (a slash command's own stdout) were parsed as user prompts,
  // and the judge then flagged a violation of an instruction nobody gave.
  it('classifies a meta record as a command, never a prompt', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      isMeta: true,
      timestamp: '2026-10-23T06:15:07.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'wrote /tmp/report.html' }] },
    });
    const events = parse('x.jsonl', line, 's1').events;
    expect(events.map((e) => e.turnType)).not.toContain('user_prompt');
  });

  it('still counts a real prompt as one', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-10-23T06:15:07.000Z',
      message: { role: 'user', content: 'please fix the parser' },
    });
    expect(parse('x.jsonl', line, 's1').events.map((e) => e.turnType)).toContain('user_prompt');
  });
});

describe('whole sentences, up to a budget', () => {
  // Keep whole sentences up to the budget, not just the first: the judge often writes the what, then the why.
  const two =
    'The agent parsed the secrets. It should have asked, because a bare path is not an instruction.';

  it('keeps both when they fit', () => {
    expect(firstSentence(two, 240)).toBe(two);
  });

  it('stops at a sentence end when they do not', () => {
    const out = firstSentence(two, 70);
    expect(out).toBe('The agent parsed the secrets.');
    expect(out, 'a trailing fragment reads as a bug').not.toMatch(/…$/);
  });

  it('still bounds a single sentence that overruns alone', () => {
    // The one honest ellipsis: no sentence end inside the budget.
    const out = firstSentence('A single sentence longer than the budget allows here', 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toMatch(/…$/);
  });

  it('leaves short text exactly as written', () => {
    expect(firstSentence('Short.', 240)).toBe('Short.');
  });
});

describe('cache rebuilds are flagged, stated, never judged', () => {
  // `cacheRead` cannot be divided (GRAVEYARD.md, cache hit rate); a rebuild is where it collapses
  // from its own running level while `cacheCreation` fires. Runs the real `sessionStats`.
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString();
  const call = (create: number, read: number, minute: number, over: Partial<Event> = {}): Event =>
    ev({ turnType: 'assistant_msg', responseId: `r${seq + 1}`, ts: at(minute), tokens: { cacheCreation: create, cacheRead: read }, ...over });
  const stats = (events: Event[]) => sessionStats(events);

  it('says nothing when the cache was never lost', () => {
    const steady = stats([call(18_000, 0, 0), call(400, 40_000, 1), call(300, 41_000, 2)]);
    expect(steady.rebuilds.events).toEqual([]);
    expect(renderRebuilds(steady)).toEqual([]);
  });

  it('does not mistake a large legitimate write for a rebuild', () => {
    // A big file read grows the prefix legitimately; a rebuild has nothing left to read.
    const bigRead = stats([call(400, 90_000, 0), call(60_000, 92_000, 1)]);
    expect(renderRebuilds(bigRead), 'the prefix survived').toEqual([]);
  });

  it('flags one when the prefix was thrown away, with its turn, gap and numbers', () => {
    const lost = stats([call(400, 90_000, 0), call(250_000, 0, 70)]);
    expect(lost.rebuilds.events).toHaveLength(1);
    expect(lost.rebuilds.events[0]?.gapMinutes).toBe(70);
    const out = renderRebuilds(lost).join('\n');
    expect(out).toMatch(/! cache rebuilt at turn \d+, 70 minutes after the previous request/);
    expect(out).toContain('250,000 cache write');
    expect(out).toContain('the cache held 90k before it');
  });

  it('does not call a compaction a rebuild', () => {
    // A compaction replaces the prefix on purpose, so the next read is small by design.
    const compacted = stats([
      call(400, 90_000, 0),
      ev({ turnType: 'assistant_msg', systemKind: 'compaction', compaction: { preTokens: 90_000, postTokens: 5_000 } }),
      call(5_000, 0, 1),
    ]);
    expect(compacted.rebuilds.events).toEqual([]);
  });

  it('compares a subagent only with itself', () => {
    // Each context is compared to its own level: a small subagent read after a large main-thread one is not a collapse.
    const mixed = stats([
      call(400, 90_000, 0),
      call(3_000, 1_000, 1, { sidechainId: 'agent-1' }),
      call(400, 91_000, 2),
    ]);
    expect(mixed.rebuilds.events).toEqual([]);
  });

  it('counts a response split across records once', () => {
    const r = 'split';
    const lost = stats([
      call(400, 90_000, 0),
      call(250_000, 0, 70, { responseId: r }),
      call(250_000, 0, 70, { responseId: r }),
    ]);
    expect(lost.rebuilds.events).toHaveLength(1);
  });

  it('lists the largest few and says how many more', () => {
    const many: Event[] = [];
    for (let i = 0; i < 5; i += 1) many.push(call(400, 90_000, i * 100), call(100_000 + i, 0, i * 100 + 60));
    const out = renderRebuilds(stats(many));
    expect(out.filter((l) => l.includes('!'))).toHaveLength(3);
    expect(out.join('\n')).toMatch(/and 2 more/);
  });

  it('carries no verb, no remedy, no comparison and no hit rate', () => {
    // A write/read multiple turns a fact into a reproach.
    const out = renderRebuilds(stats([call(400, 90_000, 0), call(250_000, 0, 70)])).join('').toLowerCase();
    for (const nag of ['should', 'avoid', 'instead', 'try', 'cheaper', '12x', '12×', 'hit rate', '%']) {
      expect(out, `"${nag}" turns this into advice or a ratio`).not.toContain(nag);
    }
  });
});
