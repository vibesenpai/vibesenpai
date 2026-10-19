import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runDetectors, detectorsFor, countDenominators } from '../src/detect/index.ts';
import { staticLookup, coldLookup } from '../src/verify.ts';
import { toolLoop, runsOf, signatureOf } from '../src/detect/tool-loop.ts';
import { revertChurn, destructiveKind } from '../src/detect/revert-churn.ts';
import { inaccurateSelfReport } from '../src/detect/inaccurate-self-report.ts';
import { hasSuccessClaim } from '../src/detect/claims.ts';
import { collect, mergeFindings, materialise, findingId, subjectIdOf } from '../src/finding.ts';
import type { Event, Finding } from '../src/types.ts';
import type { SessionFacts } from '../src/detect/types.ts';

let seq = 0;
function ev(over: Partial<Event> & Pick<Event, 'turnType'>): Event {
  seq += 1;
  return {
    sessionId: 's1',
    harness: 'claude-code',
    uuid: over.uuid ?? `u${seq}`,
    parentUuid: null,
    seq: over.seq ?? seq,
    isSidechain: false,
    ts: '2026-10-18T00:00:00.000Z',
    ...over,
  } as Event;
}

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: 's1',
  project: 'proj',
  verification: staticLookup(['npm test']),
  live: false,
  ...over,
});

/**
 * `argHash` stands in for the parser's digest of the call's full arguments.
 * Without it `signatureOf` returns undefined and no two calls compare equal —
 * which is the behaviour, not a test artifact.
 */
const hash = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);

const bash = (command: string, uuid?: string): Event =>
  ev({
    turnType: 'tool_use',
    toolName: 'Bash',
    command,
    argHash: hash(command),
    ...(uuid ? { uuid } : {}),
  });

/** A call to a tool whose arguments the parser cannot name — only digest. */
const opaque = (tool: string, args: string): Event =>
  ev({ turnType: 'tool_use', toolName: tool, argHash: hash(args) });
const result = (textSummary?: string): Event =>
  ev({ turnType: 'tool_result', ...(textSummary !== undefined ? { textSummary } : {}) });
const edit = (filePath: string): Event =>
  ev({ turnType: 'tool_use', toolName: 'Edit', filePath, argHash: hash(filePath) });

describe('finding — identity is keyed on the subject, never the evidence', () => {
  it('keeps the same id as evidence grows', () => {
    // If identity included extent, a 7-violation finding would become a
    // different finding at the 8th — losing its history and re-nagging anyone
    // who dismissed it.
    const a = findingId('tool_loop', 's1', 'Bash npm test');
    const b = findingId('tool_loop', 's1', 'Bash npm test');
    expect(a).toBe(b);
  });

  it('separates per-session from cross-session identity', () => {
    const id1 = findingId('x', 's1', 'subj');
    const id2 = findingId('x', 's2', 'subj');
    const sub1 = subjectIdOf('x', 'proj', 'subj');
    const sub2 = subjectIdOf('x', 'proj', 'subj');
    expect(id1).not.toBe(id2); // different sessions
    expect(sub1).toBe(sub2); // same project and subject
  });

  it('cannot be collided by shifting a delimiter', () => {
    // Length-prefixed hashing: ("ab","c") must not equal ("a","bc").
    expect(findingId('ab', 'c', 'x')).not.toBe(findingId('a', 'bc', 'x'));
  });
});

describe('finding — the merge that fixes M1 double-counting', () => {
  const f = (uuids: string[], over: Partial<Finding> = {}): Finding =>
    materialise({
      candidate: {
        dimension: 'tool_loop',
        subject: 'Bash npm test',
        evidence: uuids.map((u) => ({ uuid: u, sessionId: 's1' })),
        confidence: 'certain',
        method: 'RULE+T',
        polarity: 'lower-is-better',
        requiresOutcome: false,
      },
      sessionId: 's1',
      project: 'proj',
      now: '2026-10-18T00:00:00.000Z',
    }) as Finding & typeof over;

  it('counts a turn once even when two windows both saw it', () => {
    // The reason M1 shipped non-overlapping windows. `occurrences` now describes
    // the session rather than the slicing.
    const merged = mergeFindings(f(['a', 'b', 'c']), f(['c', 'd']));
    expect(merged.evidence.map((e) => e.uuid)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.occurrences).toBe(4);
  });

  it('keeps the earlier firstSeen — it is the age of the pattern', () => {
    const old = { ...f(['a']), firstSeen: '2026-10-01T00:00:00.000Z' };
    const recent = { ...f(['b']), firstSeen: '2026-10-18T00:00:00.000Z' };
    expect(mergeFindings(old, recent).firstSeen).toBe('2026-10-01T00:00:00.000Z');
  });

  it('keeps `surfaced` sticky, so a nudge is not shown twice', () => {
    const shown = { ...f(['a']), surfaced: true };
    expect(mergeFindings(shown, f(['b'])).surfaced).toBe(true);
    expect(mergeFindings(f(['b']), shown).surfaced).toBe(true);
  });

  it("preserves the user's dismissal across a merge", () => {
    const dismissed = { ...f(['a']), dismissed: { at: '2026-10-10T00:00:00.000Z' } };
    expect(mergeFindings(dismissed, f(['b'])).dismissed).toBeDefined();
  });

  it('refuses to merge findings that are not the same finding', () => {
    const other = { ...f(['a']), id: 'different' };
    expect(() => mergeFindings(f(['a']), other)).toThrow(/refusing to merge/);
  });

  it('folds many candidates into one finding per subject', () => {
    const findings = collect(
      [
        {
          dimension: 'tool_loop',
          subject: 'Bash npm test',
          evidence: [{ uuid: 'a', sessionId: 's1' }],
          confidence: 'certain',
          method: 'RULE+T',
          polarity: 'lower-is-better',
          requiresOutcome: false,
        },
        {
          dimension: 'tool_loop',
          subject: 'Bash npm test',
          evidence: [{ uuid: 'b', sessionId: 's1' }],
          confidence: 'certain',
          method: 'RULE+T',
          polarity: 'lower-is-better',
          requiresOutcome: false,
        },
      ],
      { sessionId: 's1', project: 'proj', now: '2026-10-18T00:00:00.000Z' },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.occurrences).toBe(2);
  });
});

describe('tool_loop — structural, hence certain', () => {
  const run = async (events: Event[], minRepeats = 3) =>
    (await runDetectors({
      events,
      session: facts(),
      detectors: [toolLoop({ minRepeats })],
      now: '2026-10-18T00:00:00.000Z',
    })).findings;

  it('fires on three identical calls with nothing between', async () => {
    const f = await run([
      bash('npm test'), result('FAIL'),
      bash('npm test'), result('FAIL'),
      bash('npm test'), result('FAIL'),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.dimension).toBe('tool_loop');
    expect(f[0]!.subject).toBe('Bash npm test');
    expect(f[0]!.occurrences).toBe(3);
    expect(f[0]!.confidence).toBe('certain');
  });

  it('does NOT fire when an edit sits between — that is fail_fix_fail', async () => {
    // Something changed, so the retry was informed. Different dimension,
    // different advice, and it needs an outcome (M2b).
    const f = await run([
      bash('npm test'), result('FAIL'),
      edit('src/a.ts'),
      bash('npm test'), result('FAIL'),
      edit('src/a.ts'),
      bash('npm test'), result('FAIL'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('does NOT fire when every result differs — the caller was learning', async () => {
    // The polling guard. A growing log or changing status is new information,
    // which is precisely what "no new information" excludes.
    const f = await run([
      bash('curl /health'), result('starting'),
      bash('curl /health'), result('migrating'),
      bash('curl /health'), result('ready'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('still fires when polling returns the same answer every time', async () => {
    const f = await run([
      bash('curl /health'), result('not ready'),
      bash('curl /health'), result('not ready'),
      bash('curl /health'), result('not ready'),
    ]);
    expect(f).toHaveLength(1);
  });

  it('breaks the run at a user prompt — new instruction, fresh attempt', async () => {
    const f = await run([
      bash('npm test'), result('FAIL'),
      bash('npm test'), result('FAIL'),
      ev({ turnType: 'user_prompt', textSummary: 'try something else' }),
      bash('npm test'), result('FAIL'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('continues across assistant prose, which changes nothing', async () => {
    const f = await run([
      bash('npm test'), result('FAIL'),
      ev({ turnType: 'assistant_msg', textSummary: 'let me try that again' }),
      bash('npm test'), result('FAIL'),
      ev({ turnType: 'assistant_msg', textSummary: 'once more' }),
      bash('npm test'), result('FAIL'),
    ]);
    expect(f).toHaveLength(1);
  });

  it('respects a configurable threshold', async () => {
    const two = [bash('npm test'), result('FAIL'), bash('npm test'), result('FAIL')];
    expect(await run(two, 3)).toHaveLength(0);
    expect(await run(two, 2)).toHaveLength(1);
  });

  it('does not conflate two different commands', () => {
    const rs = runsOf([bash('npm test'), result(), bash('npm run build'), result()]);
    expect(rs).toHaveLength(0); // neither repeated
  });

  it('tells apart two calls to a tool whose arguments we cannot name', async () => {
    // The measured false positive: `command`/`filePath`/`pattern` cover Bash,
    // Read, Edit and Grep only, so six separate TaskCreate calls once looked
    // like one call repeated six times — at `certain` confidence.
    const f = await run([
      opaque('TaskCreate', 'task one'), result('created #1'),
      opaque('TaskCreate', 'task two'), result('created #2'),
      opaque('TaskCreate', 'task three'), result('created #3'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('still fires when the SAME opaque call is genuinely repeated', async () => {
    const f = await run([
      opaque('TaskUpdate', 'same args'), result('ok'),
      opaque('TaskUpdate', 'same args'), result('ok'),
      opaque('TaskUpdate', 'same args'), result('ok'),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.subject).toMatch(/^TaskUpdate #/); // opaque but stable
  });

  it('skips a call with no arguments at all rather than assuming sameness', async () => {
    const noArgs = (): Event => ev({ turnType: 'tool_use', toolName: 'Whoami' });
    const f = await run([noArgs(), result('a'), noArgs(), result('a'), noArgs(), result('a')]);
    expect(f).toHaveLength(0);
  });

  it('does not flag a polling tool for polling', async () => {
    // The only tool_loop finding across 227 real sessions, and it was wrong:
    // calling BashOutput three times on a running job is the tool working.
    const poll = (): Event => ev({ turnType: 'tool_use', toolName: 'BashOutput', argHash: hash('bash_1') });
    const f = await run([
      poll(), result('<status>running</status>'),
      poll(), result('<status>running</status>'),
      poll(), result('<status>running</status>'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('compares results after normalising volatile parts', async () => {
    // Durations and counts differ every run, so without normalisation every
    // repeat looks like new information: 0 of 19 real runs survived that guard.
    const f = await run([
      bash('npm test'), result('FAIL 3 tests in 1.21s'),
      bash('npm test'), result('FAIL 3 tests in 1.47s'),
      bash('npm test'), result('FAIL 3 tests in 0.98s'),
    ]);
    expect(f).toHaveLength(1);
  });
});

describe('revert_churn — a neutral fact, not a failure', () => {
  const run = async (events: Event[]) =>
    (await runDetectors({
      events,
      session: facts(),
      detectors: [revertChurn()],
      now: '2026-10-18T00:00:00.000Z',
    })).findings;

  it('reports a hard reset after edits as discarded work', async () => {
    const f = await run([edit('src/a.ts'), bash('git reset --hard HEAD~1')]);
    expect(f).toHaveLength(1);
    expect(f[0]!.subject).toBe('git reset --hard');
    // Neutral: discarding a deliberate spike is good engineering.
    expect(f[0]!.polarity).toBe('neutral');
  });

  it('does NOT fire when the session edited nothing', async () => {
    // Somebody tidying their tree before starting has not discarded this
    // session's work.
    const f = await run([bash('git reset --hard HEAD~1')]);
    expect(f).toHaveLength(0);
  });

  it('recognises each destructive form', () => {
    expect(destructiveKind('git checkout -- src/a.ts')).toBe('git checkout --');
    expect(destructiveKind('git restore src/a.ts')).toBe('git restore');
    expect(destructiveKind('git reset --hard')).toBe('git reset --hard');
    expect(destructiveKind('git stash drop')).toBe('git stash drop');
    expect(destructiveKind('git clean -fd')).toBe('git clean -f');
  });

  it('leaves non-destructive git alone', () => {
    for (const cmd of [
      'git status',
      'git checkout main',
      'git reset HEAD~1',
      'git stash',
      'git diff',
    ]) {
      expect(destructiveKind(cmd)).toBeUndefined();
    }
  });
});

describe('denominators — one pass, never incremental', () => {
  // Detectors run per window; these are per session. If a detector incremented
  // them, a run stopped halfway would bank partial findings against partial
  // denominators and every rate would be silently wrong.
  it('counts turns, edits and tool calls', () => {
    const d = countDenominators(
      [
        ev({ turnType: 'user_prompt', textSummary: 'go' }),
        edit('src/a.ts'),
        bash('npm test'),
      ],
      staticLookup(['npm test']),
    );
    expect(d).toMatchObject({ turnCount: 1, editCount: 1, toolCallCount: 2 });
  });

  it('credits every edit a later verification covers', () => {
    // One test run clears the edits that preceded it, which is what happened.
    const d = countDenominators(
      [edit('a.ts'), edit('b.ts'), bash('npm test')],
      staticLookup(['npm test']),
    );
    expect(d.verifiedEditCount).toBe(2);
  });

  it('leaves edits after the last verification uncredited', () => {
    const d = countDenominators(
      [edit('a.ts'), bash('npm test'), edit('b.ts')],
      staticLookup(['npm test']),
    );
    expect(d.verifiedEditCount).toBe(1);
  });

  it('counts success claims narrowly', () => {
    // This divides `inaccurate_self_report`; a loose pattern inflates the
    // denominator and makes the rate look better than it is.
    const claims = ['Fixed — all tests pass now.', 'Done.', 'That works now'];
    const notClaims = ['Let me check whether that passes', 'This might be fixed by', 'Running tests'];
    for (const t of claims) {
      expect(countDenominators([ev({ turnType: 'assistant_msg', textSummary: t })], coldLookup()).successClaimCount).toBe(1);
    }
    for (const t of notClaims) {
      const n = countDenominators([ev({ turnType: 'assistant_msg', textSummary: t })], coldLookup()).successClaimCount;
      expect(n, `should not count: ${t}`).toBe(0);
    }
  });

  it('credits nothing when the project is cold', () => {
    // "Cannot tell" is a different claim from "nothing was verified".
    expect(countDenominators([edit('a.ts'), bash('npm test')], coldLookup()).verifiedEditCount).toBe(0);
  });
});

describe('runner — isolation and presets', () => {
  it('counts a throwing detector instead of losing the window', async () => {
    // Principle Zero: one detector's bug must not cost the others' findings.
    const broken = {
      ...toolLoop(),
      dimension: 'broken',
      detect: async () => {
        throw new Error('boom');
      },
    };
    const r = await runDetectors({
      events: [bash('npm test'), result('FAIL'), bash('npm test'), result('FAIL'), bash('npm test'), result('FAIL')],
      session: facts(),
      detectors: [broken, toolLoop()],
      now: '2026-10-18T00:00:00.000Z',
    });
    expect(r.failures['broken']).toBeGreaterThan(0);
    expect(r.findings).toHaveLength(1); // tool_loop still reported
  });

  it('core is a subset of all', () => {
    const core = detectorsFor('core').map((d) => d.dimension);
    const all = detectorsFor('all').map((d) => d.dimension);
    expect(core.every((d) => all.includes(d))).toBe(true);
  });

  it('every core detector is certain or high — the first finding decides trust', () => {
    for (const d of detectorsFor('core')) {
      expect(['certain', 'high'], `${d.dimension} is ${d.confidence}`).toContain(d.confidence);
    }
  });

  it('no core detector requires an outcome before M2b', () => {
    for (const d of detectorsFor('core')) expect(d.requiresOutcome).toBe(false);
  });

  it('restricts to an explicit dimension list', () => {
    expect(detectorsFor('all', ['tool_loop']).map((d) => d.dimension)).toEqual(['tool_loop']);
  });

  it('every detector describes itself in prose, never as a bare count', () => {
    // Nudges need a short description, not a number. The singular form names
    // the subject; the plural may omit it, because quoting one claim when three
    // were made would misrepresent the finding.
    for (const d of detectorsFor('all')) {
      const one = d.describe('subject-here', 1);
      expect(one, d.dimension).toContain('subject-here');

      const many = d.describe('subject-here', 3);
      expect(many.length, d.dimension).toBeGreaterThan(20);
      // Not just a count: there must be words carrying the meaning.
      expect(many.replace(/[^a-z ]/gi, '').trim().split(/\s+/).length, d.dimension)
        .toBeGreaterThan(3);
    }
  });
});

describe('inaccurate_self_report — the transcript disagreeing with itself', () => {
  const run = async (events: Event[]) =>
    (await runDetectors({
      events,
      session: facts(),
      detectors: [inaccurateSelfReport()],
      now: '2026-10-18T00:00:00.000Z',
    })).findings;

  const failed = (text: string): Event =>
    ev({ turnType: 'tool_result', isError: true, textSummary: text });
  const passed = (text: string): Event =>
    ev({ turnType: 'tool_result', exitCode: 0, textSummary: text });
  const says = (text: string): Event => ev({ turnType: 'assistant_msg', textSummary: text });

  it('fires when success is claimed over a failing check', async () => {
    const f = await run([
      bash('npm test'),
      failed('FAIL 2 tests'),
      says('Fixed — all tests pass now.'),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.confidence).toBe('certain');
    expect(f[0]!.evidence).toHaveLength(2); // the failure AND the claim
  });

  it('does not fire when the last check passed', async () => {
    const f = await run([bash('npm test'), passed('3 passed'), says('All tests pass now.')]);
    expect(f).toHaveLength(0);
  });

  it('does not fire when no check ran — that is no_verification', async () => {
    // Reporting one event under two dimensions would double-count it in the
    // running score and make both rates wrong.
    const f = await run([edit('src/a.ts'), says('Done.')]);
    expect(f).toHaveLength(0);
  });

  it('skips a SCOPED claim, which can be true while other tests fail', async () => {
    // The spec's one real false-positive path. Without subject-to-failure
    // matching we cannot tell a true scoped claim from a false global one.
    const f = await run([
      bash('npm test'),
      failed('FAIL 2 tests'),
      says('Fixed the import error — two unrelated tests still fail.'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('skips a hedged claim — hedging is not a claim', async () => {
    const f = await run([
      bash('npm test'),
      failed('FAIL'),
      says('That might be fixed by casting earlier.'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('forgets the failure after a new user prompt', async () => {
    // A new instruction means the old failure may not be what is being claimed.
    const f = await run([
      bash('npm test'),
      failed('FAIL'),
      ev({ turnType: 'user_prompt', textSummary: 'leave that, do something else' }),
      says('Done.'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('reports one finding per contradiction, not per claim word', async () => {
    const f = await run([
      bash('npm test'),
      failed('FAIL'),
      says('Fixed. Done. Everything works.'),
    ]);
    expect(f).toHaveLength(1);
  });

  it('agrees with the denominator about what a claim is', async () => {
    // If the two disagreed, the rate would divide two different populations —
    // and look perfectly reasonable while being meaningless.
    const text = 'Fixed — all tests pass now.';
    expect(hasSuccessClaim(text)).toBe(true);
    const f = await run([bash('npm test'), failed('FAIL'), says(text)]);
    expect(f).toHaveLength(1);
  });
});

describe('occurrences counts instances, not cited turns', () => {
  // Found by running against real sessions: every false claim reported
  // `occurrences: 2`, because a contradiction cites both the failing check and
  // the claim. One false claim is one occurrence.
  it('counts one occurrence for a two-turn contradiction', async () => {
    const f = (
      await runDetectors({
        events: [
          bash('npm test'),
          ev({ turnType: 'tool_result', isError: true, textSummary: 'FAIL' }),
          ev({ turnType: 'assistant_msg', textSummary: 'Fixed — all tests pass now.' }),
        ],
        session: facts(),
        detectors: [inaccurateSelfReport()],
        now: '2026-10-18T00:00:00.000Z',
      })
    ).findings;
    expect(f[0]!.occurrences).toBe(1);
    expect(f[0]!.evidence).toHaveLength(2); // both turns still shown
    expect(f[0]!.anchors).toHaveLength(1);
  });

  it('still counts every repeated call for tool_loop', async () => {
    // Where each cited turn IS an instance, the count is unchanged.
    const f = (
      await runDetectors({
        events: [
          bash('npm test'), result('FAIL'),
          bash('npm test'), result('FAIL'),
          bash('npm test'), result('FAIL'),
        ],
        session: facts(),
        detectors: [toolLoop()],
        now: '2026-10-18T00:00:00.000Z',
      })
    ).findings;
    expect(f[0]!.occurrences).toBe(3);
  });

  it('merges anchors by uuid, so a shared turn counts once', () => {
    const mk = (anchors: string[], evid: string[]) =>
      materialise({
        candidate: {
          dimension: 'inaccurate_self_report',
          subject: 'fixed',
          evidence: evid.map((u) => ({ uuid: u, sessionId: 's1' })),
          anchors: anchors.map((u) => ({ uuid: u, sessionId: 's1' })),
          confidence: 'certain',
          method: 'RULE',
          polarity: 'lower-is-better',
          requiresOutcome: false,
        },
        sessionId: 's1',
        project: 'proj',
        now: '2026-10-18T00:00:00.000Z',
      });
    const merged = mergeFindings(mk(['c1'], ['f1', 'c1']), mk(['c1'], ['f1', 'c1']));
    expect(merged.occurrences).toBe(1);
  });
});

describe('precision guards learned from real false positives', () => {
  // All three of this framework's first real-data findings were wrong. Each one
  // is pinned here so it cannot come back.
  it('does not treat a denied tool permission as a verification failure', async () => {
    // Real: "All scenarios done." over a result reading "The user doesn't want
    // to proceed with this tool use." Nothing was tested, so nothing was
    // contradicted — a category mistake, not a lie.
    const f = (
      await runDetectors({
        events: [
          bash('npm test'),
          ev({
            turnType: 'tool_result',
            isError: true,
            textSummary: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          }),
          ev({ turnType: 'assistant_msg', textSummary: 'All scenarios done.' }),
        ],
        session: facts(),
        detectors: [inaccurateSelfReport()],
        now: '2026-10-18T00:00:00.000Z',
      })
    ).findings;
    expect(f).toHaveLength(0);
  });

  it('does not flag a claim that names what still fails', async () => {
    // Real: "We've fixed all the sidechain-related tests. Only one test is
    // still failing: test_timeline_system_messages." That is accurate, and
    // flagging it would punish the transparency we want to reward.
    const f = (
      await runDetectors({
        events: [
          bash('npm test'),
          ev({ turnType: 'tool_result', isError: true, textSummary: 'FAIL 1 test' }),
          ev({
            turnType: 'assistant_msg',
            textSummary:
              "We've fixed all the sidechain-related tests. Only one test is still failing: test_timeline.",
          }),
        ],
        session: facts(),
        detectors: [inaccurateSelfReport()],
        now: '2026-10-18T00:00:00.000Z',
      })
    ).findings;
    expect(f).toHaveLength(0);
  });

  it('requires the failure to come from a recognised verification command', async () => {
    const events = [
      bash('ls /nope'),
      ev({ turnType: 'tool_result', isError: true, textSummary: 'No such file' }),
      ev({ turnType: 'assistant_msg', textSummary: 'Fixed.' }),
    ];
    // `ls` is not verification, so the failure cannot contradict the claim.
    expect(
      (await runDetectors({ events, session: facts(), detectors: [inaccurateSelfReport()], now: 'T' }))
        .findings,
    ).toHaveLength(0);
  });

  it('stays silent in a project with no known verification commands', async () => {
    // "No verification available here" is a state, not a finding.
    const f = (
      await runDetectors({
        events: [
          bash('npm test'),
          ev({ turnType: 'tool_result', isError: true, textSummary: 'FAIL' }),
          ev({ turnType: 'assistant_msg', textSummary: 'Fixed.' }),
        ],
        session: facts({ verification: coldLookup() }),
        detectors: [inaccurateSelfReport()],
        now: 'T',
      })
    ).findings;
    expect(f).toHaveLength(0);
  });

  it('does not match a command pattern inside a heredoc body', async () => {
    // Real: `revert_churn` fired on a `cat > doc.md <<EOF` whose body contained
    // the words "git reset --hard" — this project's own documentation.
    const writeDoc = ev({
      turnType: 'tool_use',
      toolName: 'Bash',
      command: "cat > /tmp/dims.md <<'SECTION_END'\ndestructive git commands (git reset --hard)\nSECTION_END",
      argHash: hash('doc'),
    });
    const f = (
      await runDetectors({
        events: [edit('src/a.ts'), writeDoc],
        session: facts(),
        detectors: [revertChurn()],
        now: 'T',
      })
    ).findings;
    expect(f).toHaveLength(0);
  });

  it('still fires on a real destructive command beside a heredoc', async () => {
    const f = (
      await runDetectors({
        events: [
          edit('src/a.ts'),
          ev({
            turnType: 'tool_use',
            toolName: 'Bash',
            command: "cat > /tmp/note.md <<'EOF'\nnothing here\nEOF\ngit reset --hard HEAD~1",
            argHash: hash('real'),
          }),
        ],
        session: facts(),
        detectors: [revertChurn()],
        now: 'T',
      })
    ).findings;
    expect(f).toHaveLength(1);
  });
});

describe('tool_loop — the output has to match too', () => {
  const run = async (events: Event[]) =>
    (await runDetectors({
      events,
      session: facts(),
      detectors: [toolLoop()],
      now: 'T',
    })).findings;

  it('does not fire when the last call returned something new', async () => {
    // The gap in the weaker "not all distinct" test: [FAIL, FAIL, OK] still
    // fired, even though the third call plainly returned new information.
    const f = await run([
      bash('npm test'), result('FAIL token undefined'),
      bash('npm test'), result('FAIL token undefined'),
      bash('npm test'), result('OK 12 passed'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('does not fire while the failure count is going down', async () => {
    // Steady progress. Blanket digit-stripping collapsed these to one string and
    // reported the healthiest possible pattern as a loop.
    const f = await run([
      bash('npm test'), result('Tests: 3 failed, 9 passed'),
      bash('npm test'), result('Tests: 2 failed, 10 passed'),
      bash('npm test'), result('Tests: 1 failed, 11 passed'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('still fires when only the duration differs', async () => {
    const f = await run([
      bash('npm test'), result('FAIL auth.ts token undefined in 1.2s'),
      bash('npm test'), result('FAIL auth.ts token undefined in 1.4s'),
      bash('npm test'), result('FAIL auth.ts token undefined in 0.9s'),
    ]);
    expect(f).toHaveLength(1);
  });

  it('still fires when only a line number shifted', async () => {
    // The spec's own example: flaky line numbers must not split one failure
    // into three.
    const f = await run([
      bash('npm test'), result('FAIL at auth.ts:42:7 token undefined'),
      bash('npm test'), result('FAIL at auth.ts:45:7 token undefined'),
      bash('npm test'), result('FAIL at auth.ts:51:7 token undefined'),
    ]);
    expect(f).toHaveLength(1);
  });

  it('does not fire when a result was never captured', async () => {
    // We cannot read what we did not capture. `unknown` beats guessing.
    const f = await run([
      bash('npm test'), result('FAIL'),
      bash('npm test'),
      bash('npm test'), result('FAIL'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('does not fire on empty output, which tells us nothing', async () => {
    const f = await run([
      bash('grep -r TODO .'), result(''),
      bash('grep -r TODO .'), result(''),
      bash('grep -r TODO .'), result(''),
    ]);
    expect(f).toHaveLength(0);
  });

  it('does not conflate different greps — the common benign case', async () => {
    // Searching repeatedly is normal work. Different patterns are different
    // calls, which `argHash` already separates.
    const f = await run([
      bash('grep -rn "foo" src/'), result('src/a.ts:3: foo'),
      bash('grep -rn "bar" src/'), result('src/b.ts:9: bar'),
      bash('grep -rn "baz" src/'), result('src/c.ts:1: baz'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('does fire on the identical search repeated for the identical answer', async () => {
    // Same pattern, same answer, nothing changed in between: the search was a
    // no-op the second and third time.
    const f = await run([
      bash('grep -rn "foo" src/'), result('src/a.ts:3: foo'),
      bash('grep -rn "foo" src/'), result('src/a.ts:3: foo'),
      bash('grep -rn "foo" src/'), result('src/a.ts:3: foo'),
    ]);
    expect(f).toHaveLength(1);
  });
});
