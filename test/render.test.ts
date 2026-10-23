/**
 * The renderer is the product surface, so these tests are mostly about what it
 * must NOT print.
 *
 * CLAUDE.md allows two outputs — evidence, and something applicable — and bans
 * the score. A test suite that only checked formatting would let a total creep
 * in, which is the one regression that would change what this tool is.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../src/parsers/index.ts';
import { activeDuration, caveatFor, describeTurn, durationOf, headlineFor, render, renderCompaction, renderCost, renderFinding, renderJudged, shortenPath, spanOf } from '../src/render.ts';
import { materialise } from '../src/finding.ts';
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
    // An unexplained number is the thing this project exists as an alternative
    // to, and a total is what people optimise instead of reading evidence.
    for (const banned of ['score', 'grade', '/100', 'out of', 'total:']) {
      expect(out.toLowerCase(), `must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it('never prints cacheRead, however tempting a ratio looks', () => {
    // It re-counts the whole prefix per call, so any ratio on it is pinned near
    // 1 by construction — p10 0.901 to p90 0.985 across the corpus.
    const out = renderCost({
      ...zeros,
      tokens: { input: 10, output: 100, cacheRead: 9_000_000, cacheCreation: 1200 },
    }).join('\n');
    expect(out).not.toContain('9.0M');
    expect(out).not.toMatch(/hit rate/i);
    // The block speaks only for an unusual session now, so this asserts what
      // must never appear rather than what must.
      expect(out).not.toMatch(/cacheRead|9,000,000/);
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
    // The turn number and what happened there, in aligned columns. The `turn `
    // prefix was dropped: it repeated on every row and bought nothing a column
    // header does not.
    expect(out).toContain('10  Edit');
    expect(out).toContain('refused');
    // The subject is in the header, so an evidence row touching that same path
    // does not repeat it — this block would otherwise print it three times.
    expect(out.match(/\/repo\/src\/api\.ts/g)).toHaveLength(1);
    expect(out).toContain('refused');
    expect(out).toContain('not-read-first');
  });

  it('names the harness reason, never a guess, when it is unrecognised', () => {
    const e = ev({
      turnType: 'tool_result', isError: true, failureKind: 'tool',
      textSummary: '<tool_use_error>Something no release has ever said.</tool_use_error>',
    });
    expect(describeTurn(e)).toContain('Something no release');
    expect(describeTurn(e)).toContain('failed');
  });

  it('prints (reason unknown) rather than implying there was none', () => {
    const out = renderFinding(finding()).join('\n');
    expect(out).toContain('(reason unknown)');
  });
});

describe('render — an empty result is not an unanalysed one', () => {
  it('distinguishes "nothing found" from "nothing to analyse"', () => {
    const noEdits = render({ findings: [], denominators: zeros, sessionId: 's', events: [] });
    expect(noEdits).toContain('no edits');

    const clean = render({ findings: [], denominators: { ...zeros, editCount: 155 }, sessionId: 's', events: [] });
    // The denominator is what makes the difference legible.
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
    // Real shape: every file-history-snapshot lacks one. 107 in a single
    // session. The parser omits them; an empty string would sort below every
    // real timestamp and become the session start.
    const span = spanOf([
      ev({ turnType: 'system', systemKind: 'file-history' }),
      ev({ turnType: 'user_prompt', ts: '2026-10-19T10:00:00.000Z' }),
      ev({ turnType: 'user_prompt', ts: '2026-10-19T11:30:00.000Z' }),
    ]);
    expect(span.first).toBe('2026-10-19T10:00:00.000Z');
    expect(durationOf(span.first, span.last)).toBe('1h30m');
  });

  it('reads a resumed session in days, not hours', () => {
    // Measured on a real session: 174h21m is a week nobody reads as one.
    expect(durationOf('2026-10-12T00:00:00.000Z', '2026-10-19T06:00:00.000Z')).toBe('7d6h');
  });

  it('returns undefined rather than 0m when the span is unknowable', () => {
    expect(durationOf(undefined, '2026-10-19T00:00:00.000Z')).toBeUndefined();
    expect(spanOf([ev({ turnType: 'system' })]).first).toBeUndefined();
  });
});

describe('render — the cost line measures you against yourself', () => {
  // It used to quote `corpus median 17.9` — hand-copied from 1,132 SWE-chat
  // sessions, which is to say other people's. A reader cannot check it, cannot
  // find it and has no relationship with it. The baseline is now their own
  // history, the one yardstick they own.
  const session = (cacheCreation: number) => ({
    ...zeros,
    tokens: { input: 0, output: 1000, cacheRead: 0, cacheCreation },
  });
  const usual = { ratio: 5, sessions: 20 };

  it('says nothing when the session is ordinary for this user', () => {
    // Presence is the signal — D62, applied where it had been waived. A line
    // reporting "normal" every run teaches people to skip the output.
    expect(renderCost(session(7000), undefined, usual)).toEqual([]);
  });

  it('speaks when the session is unlike their others, and still does not judge it', () => {
    const out = renderCost(session(200_000), undefined, usual).join('\n');
    expect(out).toMatch(/your usual/);
    expect(out).not.toMatch(/bad|too high|excessive|warning/i);
  });

  it('never names a corpus, a percentile or a median', () => {
    const out = renderCost(session(200_000), undefined, usual).join('\n');
    expect(out).not.toMatch(/corpus|percentile|median/i);
  });

  it('stays silent rather than borrow a baseline the reader cannot see', () => {
    // Too few sessions to have a "usual". The old code printed the corpus
    // comparison here, which is the defect itself.
    expect(renderCost(session(200_000), undefined, { ratio: 5, sessions: 2 })).toEqual([]);
    expect(renderCost(session(200_000), undefined, undefined)).toEqual([]);
  });

  it('prints nothing at all when there is no token data', () => {
    expect(renderCost(zeros)).toEqual([]);
  });
});

describe('render — a digest subject gets a readable headline', () => {
  it('substitutes the command while keeping the digest it is keyed on', () => {
    // A detector cannot read a command, so `redundant_call` names a Bash run
    // `Bash #8e0f94`. Correct as identity, useless as a headline — and the
    // renderer is display tier, so it may read what a detector may not.
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
    // TodoWrite takes arguments we can digest but not name.
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
    // Every live detector is a rule emitting `certain`, so the old `[certain]`
    // badge had one possible value and told a reader nothing.
    expect(caveatFor(finding({}))).toBe('');
  });

  it('explains a rule that is merely close', () => {
    const c = caveatFor(finding({ confidence: 'high' }));
    expect(c).toContain('clipped');
    // Words, not a severity token.
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
    reingest: { total: 0, heaviest: [], share: 0 },
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
    // The per-turn rows (`turn 1745  1.0M → 31k`) were a debug view: a reader
    // can act on none of them, and eight of them buried the one fact that can
    // be acted on, which is that it happened at all.
    expect(out).toContain('969k');
    expect(out).not.toContain('1745');
    // Stated, not judged: no imperative, no severity word.
    expect(out).not.toMatch(/should|too |avoid|warning|reduce/i);
  });

  it('counts a compaction that carries no figures rather than hiding it', () => {
    // The older `summary` record shape reports no token counts. Two
    // compactions shown as one would be worse than one without its numbers.
    const out = renderCompaction(
      statsWith(3, [{ seq: 10, preTokens: 900, postTokens: 100 }]) as never,
    ).join('\n');
    expect(out).toContain('summarised 3 times');
    // The older record shape carries no figures. That was once stated as its
    // own line; with the rows gone there is nothing for it to qualify, and the
    // count it belongs to is already right.
    expect(out).toContain('summarised 3 times');
  });
});

describe('render — model findings are kept visibly apart', () => {
  it('labels the section so a reader knows what kind of claim it is', () => {
    // CLAUDE.md: the UI never blurs "flagged by rule" and "flagged by a model
    // at 0.7". A judge earns that caution — the first real judge response this
    // project received invented its evidence.
    const out = renderJudged(
      [{ dimension: 'inaccurate_self_report', turns: [412, 460], why: 'said green, 412 failed' }],
      0,
    ).join('\n');
    // The marker is per-row now, not a section title: grouping rule and model
    // findings under one heading would otherwise leave a model's claim
    // indistinguishable from a rule's. See CLAUDE.md on never blurring them.
    expect(out).toContain('flagged by a model');
    expect(out).toContain('inaccurate_self_report');
    expect(out).toContain('412, 460');
  });

  it('states the lag, because a judged finding is as old as the last pass', () => {
    // Showing stale model findings beside live rule findings without saying so
    // would imply a currency they do not have.
    // "Since the last pass" implied a pass had happened and fallen 23 turns
    // behind it. With no findings and a full count, there has never been one.
    expect(renderJudged([], 23).join('\n')).toContain('still in progress');
  });

  it('says nothing at all when there is nothing and no lag', () => {
    expect(renderJudged([], 0)).toEqual([]);
  });

  it('does not look broken when it simply has not run yet', () => {
    // The point of this test is the tone, and the wording that carried it
    // changed: with no findings and turns outstanding, the session has never
    // been read, so it says that rather than reporting a lag against a pass
    // that never happened.
    const out = renderJudged([], 5).join('\n');
    expect(out).toContain('still in progress');
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
    // It used to open with `session 46b591a1 · 4362 events · 2259 edits` — an
    // identifier and two counts, with the news several lines below.
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
      judged: { findings: [{ dimension: 'misread_intent', turns: [12], why: 'x' }], unjudgedTurns: 0 },
    });
    const body = out.split('\n').filter((l) => l.trim() !== '');
    expect(body[0]).toContain('1 finding');
    expect(body[1]).toContain('This session');
    expect(body[1]).toContain('This session');
    // The id is not merely demoted now, it is gone: it identified the session
    // to us and never to the reader, who can do nothing with `abcdef12` that
    // they cannot do with "this session". `--session` still takes it.
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
    // Rung 3 of the ladder. A clean bill of health must stay legible as one —
    // `PLAN.md:21` — and the denominator is what makes it a real statement.
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
    });
    expect(out).toContain('no findings across 2260 edits');
  });

  it('uses real plurals, never the "(s)" form', () => {
    // A headline reading `1 finding(s)` looks like an unfinished sentence.
    const out = render({
      findings: [], denominators: d(), sessionId: 'abcdef1234', events: [],
      judged: { findings: [{ dimension: 'overreach', turns: [1], why: 'y' }], unjudgedTurns: 0 },
    });
    expect(out.split('\n')[1]).toContain('1 finding');
    expect(out.split('\n')[1]).not.toContain('finding(s)');
  });
});

describe('duration is time worked, not time elapsed', () => {
  // A session opened at 06:14, left alone, and returned to at 18:35 reported
  // `12h20m` across 59 lines. Never wrong, and useless: nobody counts the
  // hours a tab sat open as time spent.
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
    // The threshold is deliberately generous: over-counting a long think costs
    // a minute, under-counting an afternoon costs the number's credibility.
    const out = activeDuration([
      at('2026-10-23T06:00:00.000Z'),
      at('2026-10-23T06:29:00.000Z'),
    ]);
    expect(out).toBe('29m');
  });

  it('says so rather than rounding a short session to zero', () => {
    // `durationOf` floors to whole minutes, so twenty seconds came back as
    // `0m`, which reads as a bug rather than as a short session.
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
  // `isMeta` was not read. The harness writes a slash command's own stdout
  // back as a `type: 'user'` record with `isMeta: true`, and because the array
  // branch recognised only `tool_result`, text blocks became `user_prompt`.
  //
  // Measured on `d372b7c1`: two of four user-side turns were agentsensei's own
  // output counted as the developer's prompts, and the judge anchored a
  // `constraint_violation` on one of them — reporting that the agent had
  // violated an instruction nobody gave.
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
