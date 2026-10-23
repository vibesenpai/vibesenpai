/**
 * `src/html.ts` — and the three properties that make the file safe to open.
 *
 * Each of these fails invisibly: a rendered `<script>` only misbehaves in a
 * browser, a CDN link only reaches out when someone opens the page, and a
 * leaked secret only matters once the file is shared. None of them would show
 * up by reading the output.
 */

import { describe, expect, it } from 'vitest';
import { esc, renderHtml } from '../src/html.ts';
import { redact } from '../src/redact.ts';
import type { JudgedView, ReportData, SessionView } from '../src/gather.ts';

const ZERO_COST = { written: 0, received: 0, carriedTurns: 0, carried: 0 };

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    project: 'demo',
    firstTs: '2026-10-01T10:00:00.000Z',
    lastTs: '2026-10-01T11:00:00.000Z',
    findings: [],
    judged: [],
    denominators: {
      turnCount: 2,
      editCount: 5,
      toolCallCount: 9,
      failedCallCount: 1,
      unclassifiedTouchCount: 0,
      tokens: { input: 0, output: 1000, cacheRead: 0, cacheCreation: 5000 },
    },
    stats: {
      rewritten: [],
      reingest: { total: 0, heaviest: [], share: 0 },
      compactions: { count: 0, dropped: 0, measured: [] },
    },
    cost: ZERO_COST,
    ...over,
  } as SessionView;
}

function data(over: Partial<ReportData> = {}): ReportData {
  return {
    range: { from: new Date('2026-09-01'), to: new Date('2026-10-20') },
    generatedAt: '2026-10-20T19:30:00.000Z',
    preset: 'core',
    muted: [],
    sessions: [session()],
    unreadable: 0,
    standing: {
      v: 2,
      computedAt: '2026-10-20T19:30:00.000Z',
      sessions: 1,
      edits: 5,
      tokens: { output: 1000, cacheCreation: 5000 },
      dimensions: [],
      reasons: {},
      wastedTokens: {},
      unreadable: 0,
    },
    recommendation: undefined,
    ...over,
  } as ReportData;
}

describe('esc', () => {
  it('neutralises every character that could open a tag or attribute', () => {
    expect(esc('<a href="x" title=\'y\'>&</a>')).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderHtml — safety', () => {
  it('escapes a subject that is itself markup', () => {
    // A repo really can contain a file named like this, and the report is
    // opened in the author's browser.
    const nasty = '<img src=x onerror=alert(1)>';
    const html = renderHtml(
      data({
        sessions: [
          session({
            findings: [
              {
                dimension: 'edit_retry',
                subject: nasty,
                occurrences: 1,
                caveat: '',
                reasons: [],
                cost: ZERO_COST,
                evidence: [],
                hidden: 0,
              },
            ],
          }),
        ],
      }),
    );
    expect(html).not.toContain(nasty);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // And nothing anywhere opened an img or script tag.
    expect(html).not.toMatch(/<img|<script/i);
  });

  it('reaches for nothing outside the file', () => {
    // One pasted CDN URL would undo this quietly, and a report that fetches
    // anything tells whoever answers that it exists.
    const html = renderHtml(data());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link|<img|<script|@import|url\(/i);
  });

  it('would survive the redactor unchanged', () => {
    // The same gate `scripts/verify-corpus.ts` applies to a rendered skeleton,
    // here applied to the artifact. Note this is `redact(x) === x`, NOT
    // `isIdempotent`, which returns true for text redaction would still change.
    const html = renderHtml(data());
    expect(redact(html).text).toBe(html);
  });
});

describe('renderHtml — structure', () => {
  it('needs no JavaScript to collapse a session', () => {
    const html = renderHtml(data());
    expect(html).toContain('<details>');
    expect(html).not.toContain('onclick');
  });

  it('defines both themes on tokens', () => {
    const html = renderHtml(data());
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('color-scheme:light');
  });

  it('says plainly when a session had no findings', () => {
    expect(renderHtml(data())).toContain('no findings across 5 edits');
  });

  it('counts unreadable sessions rather than dropping them', () => {
    expect(renderHtml(data({ unreadable: 3 }))).toContain('3 discovered session(s) could not be read');
  });

  it('is a complete document', () => {
    const html = renderHtml(data());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="utf-8">');
  });
});

describe('renderHtml — the rollup attributes cost to the right dimension', () => {
  it('does not give every dimension the whole report total', () => {
    // `standing.wastedTokens` is keyed by reason, not dimension, so summing it
    // per row handed each dimension everybody else's cost too. Invisible while
    // only one dimension is live.
    const mk = (dimension: string, written: number) => ({
      dimension,
      subject: `${dimension}.ts`,
      occurrences: 1,
      caveat: '',
      reasons: [],
      cost: { ...ZERO_COST, written },
      evidence: [],
      hidden: 0,
    });
    const html = renderHtml(
      data({
        sessions: [session({ findings: [mk('edit_retry', 4000), mk('redundant_call', 900)] })],
        standing: {
          ...data().standing,
          dimensions: [
            { dimension: 'edit_retry', occurrences: 1, sessions: 1, files: 1 },
            { dimension: 'redundant_call', occurrences: 1, sessions: 1, files: 1 },
          ],
        },
      }) as never,
    );
    // Each row carries its own figure, and neither carries the sum.
    expect(html).toContain('4,000+');
    expect(html).toContain('900+');
    expect(html).not.toContain('4,900+');
  });
});

describe('gatherReport — the standing it builds equals the one computeStanding would', () => {
  it('folding per session matches a second pass over the same sessions', async () => {
    // `gather` now accumulates the standing inside its own loop rather than
    // handing every session's events to `computeStanding` afterwards. The two
    // must agree, or the rollup and the recommendation would describe different
    // arithmetic from the same data.
    const { gatherReport } = await import('../src/gather.ts');
    const { computeStanding } = await import('../src/standing.ts');
    const { editRetry } = await import('../src/detect/edit-retry.ts');
    const { parse } = await import('../src/parsers/index.ts');
    const { readFileSync } = await import('node:fs');
    const { discoverTranscripts } = await import('../src/read.ts');
    const { basename } = await import('node:path');

    const sources = [`${process.env['HOME']}/.claude/projects`];
    const files = discoverTranscripts(sources).slice(0, 3);
    if (files.length === 0) return; // nothing local to compare against

    const detectors = [editRetry()];
    const now = new Date('2026-10-20T00:00:00.000Z');

    const gathered = await gatherReport({ sources, detectors, preset: 'core', muted: [], now });

    const inputs = files.map((f) => {
      const id = basename(f, '.jsonl');
      return { sessionId: id, project: 'x', events: parse(f, readFileSync(f, 'utf8'), id).events };
    });
    const { standing: direct } = await computeStanding(inputs, detectors, { now: now.toISOString() });

    // Compare the arithmetic, not the session set (gather sees every file).
    expect(Object.keys(gathered.standing.wastedTokens).sort()).toEqual(
      expect.arrayContaining(Object.keys(direct.wastedTokens).sort()),
    );
    for (const [reason, v] of Object.entries(direct.wastedTokens)) {
      const g = gathered.standing.wastedTokens[reason];
      expect(g).toBeDefined();
      // gather covers a superset of sessions, so its figure cannot be smaller.
      expect((g as { written: number }).written).toBeGreaterThanOrEqual(v.written);
    }
  });
});

describe('the report can see the model tier', () => {
  // The regression this file exists to prevent from recurring.
  //
  // `src/html.ts`, `src/gather.ts` and `src/report-line.ts` had zero references
  // to the judge between them. On a real machine that meant:
  //
  //     judge.json holds        19 findings
  //     the report header       "16 sessions · 3 findings"
  //
  // The README pitches a model that reads conversation, and the report a reader
  // would actually share could not see what it found.
  const judged = (over: Partial<JudgedView> = {}): JudgedView => ({
    dimension: 'constraint_violation',
    turns: [3630, 3633],
    why: 'The plan-mode tool result said not to edit files, and the agent edited them. A second sentence that must not appear.',
    quote: 'DO NOT write or edit any files yet',
    ...over,
  });

  it('counts judge findings in the header', () => {
    const html = renderHtml(
      data({ sessions: [session({ judged: [judged(), judged({ dimension: 'misread_intent' })] })] }),
    );
    expect(html).toMatch(/2 findings/);
  });

  it('renders the finding, its turns and its quote', () => {
    const html = renderHtml(data({ sessions: [session({ judged: [judged()] })] }));
    expect(html).toContain('constraint_violation');
    expect(html).toContain('turns 3630, 3633');
    expect(html).toContain('DO NOT write or edit any files yet');
  });

  it('marks the tier rather than letting it pass as a certain finding', () => {
    // `certain` means the harness refused the call and said why. This is a
    // model's reading. The markup must not let the two blur together.
    const html = renderHtml(data({ sessions: [session({ judged: [judged()] })] }));
    expect(html).toContain('flagged by a model');
  });

  it('clamps the model prose to its first sentence', () => {
    // The judge's label stage writes in its own register, at length. Clamping
    // is a render-time fix on purpose: changing the rubric would invalidate the
    // measured 165/232 and require re-scoring the whole labelled set.
    const html = renderHtml(data({ sessions: [session({ judged: [judged()] })] }));
    expect(html).not.toContain('A second sentence that must not appear');
  });

  it('does not say "no findings" when the judge found some', () => {
    const html = renderHtml(data({ sessions: [session({ findings: [], judged: [judged()] })] }));
    expect(html).not.toMatch(/no findings across/);
  });
});
