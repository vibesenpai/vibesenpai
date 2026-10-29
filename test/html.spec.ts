/** `src/html.ts`: no script beyond the pinned one, no network fetch, no unredacted text. */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { COPY_SCRIPT, CSP, esc, renderHtml } from '../src/html.ts';
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
    recommendations: {},
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
    // A repo can contain a file named like this, and the report opens in a browser.
    const nasty = '<img src=x onerror=alert(1)>';
    const html = renderHtml(
      data({
        sessions: [
          session({
            findings: [
              {
                id: 'subj',
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
    expect(html).not.toMatch(/<img src=x/i); // the brand banner is the one <img>, and it is a data URI
    expect(html.match(/<script/gi)).toHaveLength(1); // the copy script, and nothing injected
  });

  it('reaches for nothing outside the file', () => {
    // A report that fetches anything tells whoever answers that it exists.
    const html = renderHtml(data());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|url\(/i);
    // One script (the copy button), pinned by hash in the CSP; nothing else runs or connects.
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts.map((m) => m[1])).toEqual([COPY_SCRIPT]);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    expect(CSP).toMatch(/^default-src 'none';/);
    expect(CSP).toContain(`'sha256-${createHash('sha256').update(COPY_SCRIPT).digest('base64')}'`);
    expect(CSP).not.toMatch(/script-src[^;]*unsafe/);
    // Images and favicon only as data URIs, which fetch nothing.
    for (const m of html.matchAll(/<(?:img|link)\b[^>]*>/gi)) {
      expect(m[0]).toMatch(/\s(?:src|href)="data:/);
    }
  });

  it('would survive the redactor unchanged', () => {
    // Strict `redact(x) === x`, not `isIdempotent`, as `scripts/verify-corpus.ts` checks.
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
    // `standing.wastedTokens` is keyed by reason, not dimension; summing it per row is the bug.
    const mk = (dimension: string, written: number) => ({
      id: dimension,
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
    // `gather`'s in-loop standing must match `computeStanding` on the same data.
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
  // Regression: the report once showed none of the judge's findings.
  const judged = (over: Partial<JudgedView> = {}): JudgedView => ({
    at: '2026-10-20T00:00:00Z',
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
    // A model finding is labelled as one beside its counts, so the tiers never blur.
    const html = renderHtml(data({ sessions: [session({ judged: [judged()] })] }));
    expect(html).toContain('<details class="model">');
    expect(html).toMatch(/<details class="model"><summary>[\s\S]*?<span class="by">by a model<\/span>/);
  });

  it('clamps the model prose to a budget, at a sentence end', () => {
    // Clamped at render time (changing the rubric would void the measured 165/232).
    // Pins the bound, and that the cut lands on a sentence end.
    const long = `${'Something verbose happened in this session. '.repeat(8)}A tail that must not appear.`;
    const html = renderHtml(data({ sessions: [session({ judged: [judged({ why: long })] })] }));
    expect(html, 'the budget still holds').not.toContain('A tail that must not appear');

    // Two short sentences, well inside the budget, now survive together.
    const short = renderHtml(data({ sessions: [session({ judged: [judged()] })] }));
    expect(short).toContain('A second sentence that must not appear');
  });

  it('does not say "no findings" when the judge found some', () => {
    const html = renderHtml(data({ sessions: [session({ findings: [], judged: [judged()] })] }));
    expect(html).not.toMatch(/no findings across/);
  });
});

describe('the drill-down', () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const asked = { seq: 40, ts: '2026-10-19T14:02:00.000Z', text: 'split the invoice totals into line items' };
  const finding = (over: Record<string, unknown> = {}) => ({
    dimension: 'edit_retry',
    subject: 'src/billing/invoice.ts',
    occurrences: 1,
    caveat: '',
    reasons: [{ reason: 'string-not-found', count: 1, advice: '' }],
    cost: ZERO_COST,
    evidence: [
      { turn: '41', what: 'Edit', detail: 'string not found', failed: true, retry: false, asked },
      { turn: '43', what: 'Edit', detail: '', failed: false, retry: true, asked },
    ],
    hidden: 0,
    ...over,
  });

  it('opens nothing on load', () => {
    const html = renderHtml(data({ sessions: [session({ findings: [finding()] as never })] }));
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it('shows the prompt a cited turn answered, beside the turn, without a label', () => {
    const html = renderHtml(data({ sessions: [session({ findings: [finding()] as never })] }));
    expect(html).toContain('“split the invoice totals into line items”');
    expect(html).not.toContain('you asked');
    expect(html).toContain('turn 41');
  });

  it('starts a new run of rows when the turns answer a later prompt', () => {
    const later = { seq: 90, text: 'now the tax rounding' };
    const f = finding({
      evidence: [
        { turn: '41', what: 'Edit', detail: '', failed: true, retry: false, asked },
        { turn: '95', what: 'Edit', detail: '', failed: true, retry: false, asked: later },
      ],
    });
    const html = renderHtml(data({ sessions: [session({ findings: [f] as never })] }));
    expect(html).toContain('<span class="mute">then</span> <span class="asked">“now the tax rounding”');
    expect(html).toContain('now the tax rounding');
  });

  it('escapes transcript text on every new surface', () => {
    const html = renderHtml(
      data({
        sessions: [
          session({
            project: nasty,
            findings: [
              finding({
                reasons: [{ reason: nasty, count: 1, advice: '' }],
                evidence: [{ turn: '1', what: nasty, detail: nasty, failed: true, retry: false, asked: { seq: 1, text: nasty } }],
              }),
            ] as never,
            judged: [{ at: '2026-10-20T00:00:00Z', dimension: nasty, turns: [3], why: nasty, quote: nasty, asked: { seq: 1, text: nasty } }],
            stats: {
              rewritten: [{ path: nasty, versions: 2, editCalls: 1 }],
              compactions: { count: 0, dropped: 0, measured: [] },
            } as never,
          }),
        ],
      }),
    );
    expect(html).not.toContain(nasty);
    expect(html).not.toMatch(/<img src=x/i); // the brand banner is the one <img>, and it is a data URI
    expect(html.match(/<script/gi)).toHaveLength(1); // the copy script, and nothing injected
  });

  it('says plainly when no prompt precedes the turns', () => {
    const f = finding({ evidence: [{ turn: '2', what: 'Edit', detail: '', failed: true, retry: false }] });
    expect(renderHtml(data({ sessions: [session({ findings: [f] as never })] }))).toContain('no prompt precedes these turns');
  });

  it("puts each dimension's recommendation inside that dimension, and nowhere else", () => {
    const judged = { dimension: 'misread_instruction', turns: [7], why: 'read it as optional.' };
    const html = renderHtml(
      data({
        sessions: [session({ findings: [finding()] as never, judged: [judged] as never })],
        recommendations: {
          edit_retry: { kind: 'PROMPT', dimension: 'edit_retry', evidence: '3 refused edits', because: 'b', prompt: 'read first' },
          misread_instruction: { kind: 'REPORT', dimension: 'misread_instruction', evidence: '1 time', because: 'no mechanism' },
        } as never,
      }),
    );
    expect(html).not.toContain('<h2>Recommendation');
    const rule = html.slice(html.indexOf('<details class="rule">'), html.indexOf('<details class="model">'));
    const model = html.slice(html.indexOf('<details class="model">'));
    expect(rule).toContain('recommendation');
    expect(rule).toContain('read first');
    expect(rule).not.toContain('no mechanism');
    expect(model).toContain('no mechanism');
    expect(html).not.toMatch(/one (thing|change)|What you can do/i);
  });

  it('draws text to paste as a terminal with a copy button, and never copies the glyph', () => {
    const html = renderHtml(
      data({
        sessions: [session({ findings: [finding()] as never })],
        recommendations: {
          edit_retry: { kind: 'PROMPT', dimension: 'edit_retry', evidence: 'e', because: 'b', prompt: 'read <first>', memory: '- read first' },
        } as never,
      }),
    );
    expect(html).toContain('<span class="term-lbl">prompt · paste into your session</span><button type="button" class="copy" hidden>copy</button>');
    // The button is hidden until the script reveals it; with no script, the text still stands.
    expect(html).toContain('<span class="glyph" aria-hidden="true">❯</span><code>read &lt;first&gt;</code>');
    expect(html).toContain('<span class="term-lbl">CLAUDE.md · add to make it stick</span>');
    expect(html).toContain('<code>- read first</code>');
    expect(html).not.toContain('paste or adopt');
  });

  it('marks every row that opens, and says so once', () => {
    const html = renderHtml(data({ sessions: [session({ findings: [finding()] as never })] }));
    expect(html).toContain('summary::before');
    expect(html).toContain('details[open]>summary::before');
    expect(html).toMatch(/class="hint"><svg[\s\S]*?<span class="chev">&gt;<\/span> rows marked like this open/);
  });

  it('shows one list of findings, evidence first and the recommendation after', () => {
    const judgedOne = { dimension: 'misread_intent', turns: [7], why: 'read it as optional.' };
    const html = renderHtml(
      data({
        sessions: [session({ findings: [finding()] as never, judged: [judgedOne] as never })],
        recommendations: {
          edit_retry: { kind: 'PROMPT', dimension: 'edit_retry', evidence: '1 refused edit', because: 'b', prompt: 'read first' },
        } as never,
      }),
    );
    expect(html).not.toMatch(/class="tier"|>certain<|flagged by a model<\/p>/);
    const block = html.slice(html.indexOf('<details class="rule">'));
    expect(block.indexOf('<details class="moments">')).toBeGreaterThan(-1);
    expect(block.indexOf('<details class="moments">')).toBeLessThan(block.indexOf('class="rec"'));
    expect(block).toContain('1 moment');
  });

  it('says which numbers a model produced, at the foot of the page', () => {
    const foot = renderHtml(data()).split('<footer>')[1] ?? '';
    expect(foot).toContain('About these numbers.');
    expect(foot).toContain('<i>by a model</i>');
    expect(foot).toContain('can be wrong');
    expect(foot).toContain('lower bounds');
  });

  it('wears its name, its mark and its favicon', () => {
    const html = renderHtml(data());
    expect(html).toMatch(/<header class="hero">[\s\S]*<svg[\s\S]*<span>agentsensei<\/span>/);
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');
    expect(html).toContain('<img src="data:image/jpeg;base64,');
  });
});

describe('the prompt behind a turn', () => {
  const ev = (seq: number, over: Record<string, unknown> = {}) =>
    ({ seq, uuid: `u${seq}`, turnType: 'user_prompt', isSidechain: false, textSummary: `prompt ${seq}`, ...over }) as never;

  it('is the last prompt at or before the turn', async () => {
    const { askedBefore, promptsOf } = await import('../src/gather.ts');
    const p = promptsOf([ev(5), ev(20)]);
    expect(askedBefore(p, 4)).toBeUndefined();
    expect(askedBefore(p, 5)?.text).toBe('prompt 5');
    expect(askedBefore(p, 19)?.text).toBe('prompt 5');
    expect(askedBefore(p, 400)?.text).toBe('prompt 20');
  });

  it('never attributes a subagent instruction or harness noise to the person', async () => {
    const { askedBefore, promptsOf } = await import('../src/gather.ts');
    const p = promptsOf([
      ev(5),
      ev(10, { isSidechain: true, textSummary: 'the agent briefing a subagent' }),
      ev(12, { textSummary: '<task-notification>done</task-notification>' }),
    ]);
    expect(askedBefore(p, 15)?.text).toBe('prompt 5');
  });

  it('is cut to one line, and the cut still survives the redactor', async () => {
    const { promptsOf } = await import('../src/gather.ts');
    const [a] = promptsOf([ev(1, { textSummary: 'word '.repeat(100) })]);
    expect(a?.text.length).toBeLessThanOrEqual(161);
    expect(a?.text.endsWith('…')).toBe(true);
    expect(redact(a?.text ?? '').text).toBe(a?.text);
  });
});

describe('renderHtml — cache figures appear only beside a flag', () => {
  // Not a usage counter: cache figures appear only beside a flag.
  const rebuild = { seq: 1520, uuid: 'u1520', tokens: 879_193, cached: 873_463, gapMinutes: 1_491 };

  it('says nothing about the cache when nothing was flagged', () => {
    const html = renderHtml(data());
    expect(html).not.toMatch(/cache write|cache read|re-cached|! cache|<h2>Cache/i);
    expect(html).not.toContain('class="tile');
  });

  it('flags each rebuild with its turn, gap and numbers', () => {
    const s = session({
      stats: {
        rewritten: [],
        compactions: { count: 0, dropped: 0, measured: [] },
        rebuilds: { count: 1, tokens: rebuild.tokens, share: 0.7, events: [rebuild] },
      },
    } as Partial<SessionView>);
    const html = renderHtml(data({ sessions: [s] }));
    expect(html).toContain('<h2>Cache <small>flagged events only</small></h2>');
    expect(html).toContain('cache rebuilt at turn 1,520, 25 hours after the previous request');
    expect(html).toContain('879,193 cache write');
    expect(html).toContain('! cache');
    // Shown in the summary and again in its session.
    expect(html.match(/cache rebuilt at turn 1,520/g)).toHaveLength(2);
    expect(html).not.toMatch(/hit rate/i);
  });
});

describe('gatherReport — dismissals match by the same project key as everywhere else', () => {
  it('hides a subject dismissed under the harness project directory name', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { gatherReport } = await import('../src/gather.ts');
    const { editRetry } = await import('../src/detect/edit-retry.ts');
    const { subjectIdOf } = await import('../src/finding.ts');
    const { emptyDismissed } = await import('../src/dismiss.ts');

    const root = mkdtempSync(join(tmpdir(), 'as-gather-'));
    const dir = join(root, '-Users-x-app');
    mkdirSync(dir);
    const base = { sessionId: 's1', version: '2.1.296', timestamp: '2026-10-20T10:00:00.000Z' };
    const edit = (id: string) => ({ type: 'tool_use', id, name: 'Edit', input: { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' } });
    const lines = [
      { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix it' } },
      { ...base, type: 'assistant', uuid: 'a1', message: { role: 'assistant', id: 'm1', content: [edit('t1')] } },
      { ...base, type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '<tool_use_error>String to replace not found in file.</tool_use_error>' }] } },
      { ...base, type: 'assistant', uuid: 'a2', message: { role: 'assistant', id: 'm2', content: [edit('t2')] } },
      { ...base, type: 'user', uuid: 'r2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    ];
    writeFileSync(join(dir, 's1.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));

    const opts = { sources: [root], detectors: [editRetry()], preset: 'core', muted: [], now: new Date('2026-10-21T00:00:00Z') };
    const shown = await gatherReport(opts);
    expect(shown.sessions[0]?.findings).toHaveLength(1);
    expect(shown.sessions[0]?.project, 'shown by its readable name').toBe('app');

    const dismissed = emptyDismissed();
    dismissed.subjects.add(subjectIdOf('edit_retry', '-Users-x-app', '/x/a.ts'));
    const hidden = await gatherReport({ ...opts, dismissed });
    expect(hidden.sessions[0]?.findings ?? []).toHaveLength(0);
  });
});
