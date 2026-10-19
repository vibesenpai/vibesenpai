import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { outputDigest } from '../src/normalise.ts';
import {
  runDetectors,
  detectorsFor,
  countDenominators,
  allDetectors,
  editEvidenceOf,
  EDIT_TOOLS,
} from '../src/detect/index.ts';
import { collect, mergeFindings, materialise, findingId, subjectIdOf } from '../src/finding.ts';
import type { Event, Finding } from '../src/types.ts';
import type { Detector, SessionFacts } from '../src/detect/types.ts';

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
/**
 * `outHash` mirrors what the parser computes over the FULL output. Fixtures must
 * carry it, because `tool_loop` compares digests rather than summaries — the
 * summary is capped at 200 chars and 59.9% of real results hit that cap.
 */
const result = (textSummary?: string): Event =>
  ev({
    turnType: 'tool_result',
    ...(textSummary !== undefined ? { textSummary } : {}),
    ...(outputDigest(textSummary) !== undefined
      ? { outHash: outputDigest(textSummary) as string }
      : {}),
  });
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

describe('denominators — one pass, never incremental', () => {
  // Detectors run per window; these are per session. If a detector incremented
  // them, a run stopped halfway would bank partial findings against partial
  // denominators and every rate would be silently wrong.
  it('counts turns, edits and tool calls', () => {
    const d = countDenominators([
      ev({ turnType: 'user_prompt', textSummary: 'go' }),
      edit('src/a.ts'),
      bash('npm test'),
    ]);
    expect(d).toMatchObject({ turnCount: 1, editCount: 1, toolCallCount: 2 });
  });

  it('counts only failures the harness itself declared', () => {
    // Structural, and it stays that way: a text pattern tried here read
    // `0 errors, 0 warnings` as a failure, and missed 26 of 38 real non-zero
    // exits. The harness's own verdict is the only one worth having.
    const d = countDenominators([
      ev({ turnType: 'tool_result', isError: true }),
      ev({ turnType: 'tool_result', exitCode: 1 }),
      ev({ turnType: 'tool_result', exitCode: 0, textSummary: 'error: 0 errors, 0 warnings' }),
      ev({ turnType: 'tool_result', textSummary: 'FAILED — 3 tests broken' }),
    ]);
    expect(d.failedCallCount).toBe(2);
  });

  it('sums the token totals the harness billed', () => {
    const d = countDenominators([
      ev({ turnType: 'assistant_msg', tokens: { input: 10, output: 5, cacheRead: 900, cacheCreation: 40 } }),
      ev({ turnType: 'assistant_msg', tokens: { input: 2, output: 7, cacheRead: 950, cacheCreation: 10 } }),
      ev({ turnType: 'user_prompt' }),
    ]);
    expect(d.tokens).toEqual({ input: 12, output: 12, cacheRead: 1850, cacheCreation: 50 });
  });

  it('records cacheRead without ever making it a ratio', () => {
    // `cacheRead` re-counts the whole prefix on every call, so it grows with
    // the square of the turn count: read/(read+creation) measured p10 0.901 to
    // p90 0.985 across the corpus, i.e. pinned near 1 by construction. It is
    // kept as a total and never divided. See GRAVEYARD.md.
    const short = countDenominators([
      ev({ turnType: 'assistant_msg', tokens: { cacheRead: 100, cacheCreation: 100 } }),
    ]);
    const long = countDenominators(
      Array.from({ length: 20 }, () =>
        ev({ turnType: 'assistant_msg', tokens: { cacheRead: 100, cacheCreation: 0 } }),
      ),
    );
    const ratio = (d: ReturnType<typeof countDenominators>): number =>
      d.tokens.cacheRead / (d.tokens.cacheRead + d.tokens.cacheCreation);
    // The longer session scores "better" purely for being longer. Which is why
    // no detector may use it.
    expect(ratio(long)).toBeGreaterThan(ratio(short));
    expect(Object.keys(countDenominators([]))).not.toContain('cacheHitRate');
  });
});

/**
 * A detector with no rule of its own.
 *
 * The runner's behaviour — failure isolation, scope dispatch, skeleton delivery
 * — is framework, not detection. Testing it through a real detector made these
 * tests break when that detector was removed, which is backwards: the framework
 * outlives any rule that runs on it.
 */
function stub(over: Partial<Detector> = {}): Detector {
  return {
    dimension: 'stub',
    scope: 'session',
    polarity: 'neutral',
    confidence: 'certain',
    method: 'RULE',
    requiresOutcome: false,
    denominator: 'per-session',
    preset: 'core',
    describe: (subject, occurrences) =>
      occurrences === 1 ? `stub matched ${subject}` : `stub matched ${subject} ${occurrences} times`,
    detect: async () => [],
    ...over,
  };
}

/** Emits one candidate per span, named for the actor whose span it was. */
const perSpan = (over: Partial<Detector> = {}): Detector =>
  stub({
    detect: async (ctx) => {
      const calls = ctx.events.filter((e) => e.turnType === 'tool_use');
      if (calls.length === 0) return [];
      const first = calls[0]!;
      return [
        {
          dimension: 'stub',
          subject: first.sidechainId ?? 'main',
          evidence: calls.map((e) => ({ uuid: e.uuid, sessionId: e.sessionId, seq: e.seq })),
          confidence: 'certain' as const,
          method: 'RULE' as const,
          polarity: 'neutral' as const,
          requiresOutcome: false,
          artifacts: [],
        },
      ];
    },
    ...over,
  });

describe('a detector cannot read text — enforced by the compiler', () => {
  it('omits command, pattern and textSummary from the detector view', () => {
    // The whole reset in one assertion. If any of these fields becomes
    // readable again, the expect-error directives below go unused and the
    // BUILD fails — which is the point: three detectors read text to decide
    // and produced 5 true positives against ~25 false positives over 1,139
    // real sessions. See GRAVEYARD.md.
    //
    // (Written without the directive's own spelling, because a comment
    // containing it IS one — that mistake cost a confusing build error here.)
    const probe = stub({
      detect: async (ctx) => {
        const e = ctx.events[0];
        if (e !== undefined) {
          // @ts-expect-error — `command` is not on StructuralEvent.
          void e.command;
          // @ts-expect-error — `pattern` is not on StructuralEvent.
          void e.pattern;
          // @ts-expect-error — `textSummary` is not on StructuralEvent.
          void e.textSummary;
          // Structural fields are of course readable.
          void e.argHash;
          void e.isError;
          void e.filePath;
          void e.tokens;
        }
        return [];
      },
    });
    expect(probe.dimension).toBe('stub');
  });
});

describe('runner — isolation and presets', () => {
  it('counts a throwing detector instead of losing the others findings', async () => {
    // Principle Zero: one detector's bug must not cost the others' findings.
    const broken = stub({
      dimension: 'broken',
      detect: async () => {
        throw new Error('boom');
      },
    });
    const r = await runDetectors({
      events: [bash('npm test'), result('FAIL'), bash('npm test')],
      session: facts(),
      detectors: [broken, perSpan()],
      now: '2026-10-18T00:00:00.000Z',
    });
    expect(r.failures['broken']).toBeGreaterThan(0);
    expect(r.findings).toHaveLength(1); // the other detector still reported
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
    const only = detectorsFor('all', ['nothing-registered']);
    expect(only).toEqual([]);
  });

  it('every registered detector describes itself in prose, never as a bare count', () => {
    // Nudges need a short description, not a number. The singular form names
    // the subject; the plural may omit it, because quoting one instance when
    // three occurred would misrepresent the finding.
    for (const d of [...detectorsFor('all'), stub()]) {
      expect(d.describe('subject-here', 1), d.dimension).toContain('subject-here');
      const many = d.describe('subject-here', 3);
      expect(many.length, d.dimension).toBeGreaterThan(20);
      expect(many.replace(/[^a-z ]/gi, '').trim().split(/\s+/).length, d.dimension).toBeGreaterThan(3);
    }
  });

  it('registers no detector yet, and says so rather than pretending', () => {
    // The 2026-10-19 reset removed all three. This asserts the honest empty
    // state so a silent zero is never mistaken for "nothing found".
    expect(allDetectors()).toEqual([]);
  });
});

describe('occurrences counts instances, not cited turns', () => {
  // Found by running against real sessions: every finding that cited both a
  // cause turn and an effect turn reported `occurrences: 2`. One instance is
  // one occurrence, however many turns it took to evidence it.
  it('counts one occurrence for a finding evidenced by two turns', async () => {
    const twoTurnEvidence = stub({
      detect: async (ctx) => [
        {
          dimension: 'stub',
          subject: 'one instance',
          evidence: ctx.events.slice(0, 2).map((e) => ({ uuid: e.uuid, sessionId: e.sessionId, seq: e.seq })),
          anchors: ctx.events.slice(1, 2).map((e) => ({ uuid: e.uuid, sessionId: e.sessionId, seq: e.seq })),
          confidence: 'certain' as const,
          method: 'RULE' as const,
          polarity: 'neutral' as const,
          requiresOutcome: false,
          artifacts: [],
        },
      ],
    });
    const f = (
      await runDetectors({
        events: [bash('npm test'), result('FAIL')],
        session: facts(),
        detectors: [twoTurnEvidence],
        now: '2026-10-18T00:00:00.000Z',
      })
    ).findings;
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toHaveLength(2);
    expect(f[0]!.occurrences).toBe(1);
  });
});

describe('scope — the window is a token budget, not an evaluation span', () => {
  // Measured across 255 sessions: of 363 genuinely verified edits, 293 (81%)
  // were covered by a command in a LATER window. A per-window detector calls
  // every one of them unverified — a precision failure, not a recall one.
  const long = (): Event[] => {
    const out: Event[] = [];
    for (let i = 0; i < 30; i++) out.push(bash(`echo step-${i}`));
    return out;
  };

  it('a session-scoped detector sees a span that windows would split', async () => {
    const r = await runDetectors({
      events: [bash('npm test'), result('FAIL'), ...long()],
      session: facts(),
      detectors: [perSpan({ scope: 'session' })],
      now: 'T',
    });
    expect(r.windows).toBeGreaterThan(2);
    // One finding spanning every window, not one finding per window.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.evidence.length).toBeGreaterThan(30);
  });

  it('declares a scope the runner knows how to dispatch', () => {
    for (const d of [...detectorsFor('all'), stub()]) {
      expect(['window', 'thread', 'session', 'project'], d.dimension).toContain(d.scope);
    }
  });

  it('keeps a subagent span separate from the main thread', async () => {
    // Thread scope: a flat array interleaves subagent events among main-thread
    // ones, so a session-scoped rule would merge work belonging to two actors.
    const sc = (c: string): Event =>
      ev({ turnType: 'tool_use', toolName: 'Bash', command: c, argHash: hash(c), isSidechain: true, sidechainId: 'sc1' });
    const events = [sc('a'), bash('ls'), sc('b'), bash('ls'), sc('c')];

    const threaded = (
      await runDetectors({ events, session: facts(), detectors: [perSpan({ scope: 'thread' })], now: 'T' })
    ).findings;
    expect(threaded.map((f) => f.subject).sort()).toEqual(['main', 'sc1']);

    const sessioned = (
      await runDetectors({ events, session: facts(), detectors: [perSpan({ scope: 'session' })], now: 'T' })
    ).findings;
    expect(sessioned).toHaveLength(1); // both actors collapsed into one span
  });

  it('refuses project scope loudly instead of evaluating the wrong span', async () => {
    const crossSession = stub({ dimension: 'constraint_decay', scope: 'project' });
    await expect(
      runDetectors({ events: [bash('ls')], session: facts(), detectors: [crossSession], now: 'T' }),
    ).rejects.toThrow(/project scope/);
  });

  it('gives a skeleton only to window-scoped detectors', async () => {
    const seen: boolean[] = [];
    const probe = (scope: 'window' | 'session'): Detector =>
      stub({
        dimension: `probe-${scope}`,
        scope,
        detect: async (ctx) => {
          seen.push(ctx.skeleton !== undefined);
          return [];
        },
      });
    await runDetectors({ events: [bash('ls'), result('x')], session: facts(), detectors: [probe('window')], now: 'T' });
    expect(seen.every((s) => s)).toBe(true);
    seen.length = 0;
    await runDetectors({ events: [bash('ls'), result('x')], session: facts(), detectors: [probe('session')], now: 'T' });
    expect(seen.every((s) => !s)).toBe(true);
  });
});

describe('EDIT_TOOLS is one definition', () => {
  it('is exported once and covers the four Claude-owned writers', () => {
    // A legitimate allowlist: the space is closed, published, and slow-moving.
    // It previously existed as three separate copies.
    expect([...EDIT_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });
});

describe('"did a file change?" without a name allowlist', () => {
  // The rule: a closed list is authoritative where it applies, behaviour covers
  // the open remainder, and what neither decides is reported as undecided.
  const snapshot = (changed: string[]): Event =>
    ev({ turnType: 'system', systemKind: 'file-history', changedFiles: changed });

  it('counts a Claude-owned writer', () => {
    expect(editEvidenceOf(edit('src/a.ts'))).toBe('tool');
  });

  it('counts a harness-recorded change, whatever tool made it', () => {
    // The MCP case: the harness tracks the file, not the tool.
    expect(editEvidenceOf(snapshot(['src/a.ts']))).toBe('harness');
  });

  it('treats an unknown path-carrying tool as PROBABLE, never proven', () => {
    // `mcp__acp__Write` writes files; `mcp__acp__Read` does not. Both carry a
    // path, so path presence alone cannot separate them.
    const mcpWrite = ev({ turnType: 'tool_use', toolName: 'mcp__acp__Write', filePath: '/x/a.ts', argHash: hash('w') });
    expect(editEvidenceOf(mcpWrite)).toBe('probable');
  });

  it('does not mistake a reader for a writer', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) {
      const r = ev({ turnType: 'tool_use', toolName: name, filePath: '/x/a.ts', argHash: hash(name) });
      expect(editEvidenceOf(r), name).toBeUndefined();
    }
  });

  it('reports unclassified touches instead of silently undercounting', () => {
    const d = countDenominators([ev({ turnType: 'tool_use', toolName: 'mcp__acp__Write', filePath: '/x/a.ts', argHash: hash('w') })]);
    expect(d.editCount).toBe(0);
    expect(d.unclassifiedTouchCount).toBe(1);
  });

  it('credits a harness-only change as an edit', () => {
    const d = countDenominators([snapshot(['src/a.ts', 'src/b.ts'])]);
    expect(d.editCount).toBe(2);
  });

  it('does not double-count an edit its snapshot later confirms', () => {
    // One Edit plus the snapshot recording it is one edit, not two.
    const d = countDenominators([edit('src/a.ts'), snapshot(['src/a.ts'])]);
    expect(d.editCount).toBe(1);
  });

  it('dedupes across the ABSOLUTE tool path and the RELATIVE harness path', () => {
    // The real shape, and the bug the identical-literal test above missed: the
    // harness records `e2e/agents/cursor_cli.go` while the tool call carries
    // `/Users/[USER]/Projects/devenv/cli/e2e/agents/cursor_cli.go`. Compared for
    // equality they never match, and every edit in a harness-2.1 session
    // doubled — 6 tool edits plus 3 snapshots read as 9.
    const d = countDenominators([
        edit('/Users/[USER]/Projects/devenv/cli/e2e/agents/cursor_cli.go'),
        snapshot(['e2e/agents/cursor_cli.go']),
      ]);
    expect(d.editCount).toBe(1);
  });

  it('does not dedupe a different file that merely shares a name', () => {
    const d = countDenominators([edit('/Users/[USER]/app/src/index.ts'), snapshot(['vendor/src/index.ts'])]);
    expect(d.editCount).toBe(2);
  });

});
