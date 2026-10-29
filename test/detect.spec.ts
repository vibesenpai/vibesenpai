import { describe, expect, it } from 'vitest';
import { isRedundant, repeatGroups, redundantCall } from '../src/detect/redundant-call.ts';
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
import { editRetry, retriedFailures } from '../src/detect/edit-retry.ts';
import { truncatesOutput, failureKindOf } from '../src/parsers/claude-code.ts';
import { reasonOf, adviceFor } from '../src/detect/labels.ts';
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

/** Stands in for the parser's argument digest; without it no two calls compare equal. */
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

/** Mirrors the parser's digest over the FULL output; the 200-char summary is not comparable. */
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
    // Identity excludes extent, so a growing finding keeps its history and its dismissal.
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
    // `occurrences` describes the session, not the slicing.
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
  // Per session, never per window, so a partial run cannot skew rates.
  it('counts turns, edits and tool calls', () => {
    const d = countDenominators([
      ev({ turnType: 'user_prompt', textSummary: 'go' }),
      edit('src/a.ts'),
      bash('npm test'),
    ]);
    expect(d).toMatchObject({ turnCount: 1, editCount: 1, toolCallCount: 2 });
  });

  it('counts only failures the harness itself declared', () => {
    // Structural: the harness's own verdict, never a text pattern.
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
    // `cacheRead` re-counts the whole prefix per call; kept as a total, never divided. See GRAVEYARD.md.
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
    // Grows with session length, which is why no detector may use it.
    expect(ratio(long)).toBeGreaterThan(ratio(short));
    expect(Object.keys(countDenominators([]))).not.toContain('cacheHitRate');
  });
});

/** A detector with no rule of its own, so runner tests outlive any real detector. */
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
        },
      ];
    },
    ...over,
  });

describe('a detector cannot read text — enforced by the compiler', () => {
  it('omits command, pattern and textSummary from the detector view', () => {
    // If any of these fields becomes readable, the directives below go unused and the build fails.
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
    // The plural may omit the subject: quoting one instance of three would misrepresent it.
    for (const d of [...detectorsFor('all'), stub()]) {
      expect(d.describe('subject-here', 1), d.dimension).toContain('subject-here');
      const many = d.describe('subject-here', 3);
      expect(many.length, d.dimension).toBeGreaterThan(20);
      expect(many.replace(/[^a-z ]/gi, '').trim().split(/\s+/).length, d.dimension).toBeGreaterThan(3);
    }
  });

  it('registers only detectors that read structure', () => {
    // Pins the roster, so reintroducing a detector is a visible change.
    expect(allDetectors().map((d) => d.dimension)).toEqual(['edit_retry', 'redundant_call']);
  });
});

describe('occurrences counts instances, not cited turns', () => {
  // One instance is one occurrence, however many turns evidence it.
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
  // A verifying command often sits in a later window: .claude/rules/detectors.md, "Scope is a property of the detector".
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
    // A flat array interleaves subagent events, so thread scope keeps actors apart.
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
    // A legitimate allowlist: the space is closed and published.
    expect([...EDIT_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });
});

describe('"did a file change?" without a name allowlist', () => {
  // Closed list where it applies, behaviour for the rest, undecided otherwise.
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
    // Both carry a path, so path presence alone cannot separate writer from reader.
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
    // The harness records a relative path while the tool call carries an absolute one; still one edit.
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

/** Fixtures use the harness's real messages; the envelope must be exact to tell tool from hook. */
const HARNESS = {
  notRead:
    '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
  stale:
    '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>',
  ambiguous:
    '<tool_use_error>Found 3 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true.</tool_use_error>',
  denied:
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the user rejected the edit).",
  hook:
    'PreToolUse:Edit hook error: [python3 ${CLAUDE_PLUGIN_ROOT}/hooks/security_reminder_hook.py]: You are editing a sensitive file.',
  reworded:
    '<tool_use_error>Something entirely new that no release has ever said.</tool_use_error>',
  cascade: '<tool_use_error>Sibling tool call errored</tool_use_error>',
  denyRule:
    '<tool_use_error>File is covered by a Read deny rule in your permission settings</tool_use_error>',
} as const;

describe('edit_retry — the harness refused, the agent pushed on', () => {
  let n = 0;
  const editCall = (filePath: string): Event => {
    n += 1;
    return ev({
      turnType: 'tool_use',
      toolName: 'Edit',
      filePath,
      toolCallId: `call-${n}`,
      argHash: hash(`${filePath}-${n}`),
    });
  };
  /** The harness answering a specific call, parsed exactly as production does. */
  const failure = (call: Event, text: string): Event =>
    ev({
      turnType: 'tool_result',
      toolCallId: call.toolCallId as string,
      isError: true,
      failureKind: failureKindOf(text),
      textSummary: text,
    });

  const run = async (events: Event[]): Promise<Finding[]> =>
    (
      await runDetectors({
        events,
        session: facts(),
        detectors: [editRetry()],
        now: '2026-10-19T00:00:00.000Z',
      })
    ).findings;

  it('fires when a refused edit is followed by another edit to the same file', async () => {
    const a = editCall('/repo/src/api.ts');
    const f = await run([a, failure(a, HARNESS.notRead), editCall('/repo/src/api.ts')]);
    expect(f).toHaveLength(1);
    expect(f[0]!.subject).toBe('/repo/src/api.ts');
    expect(f[0]!.occurrences).toBe(1);
    // Attempt, verdict and retry: readable without opening the transcript.
    expect(f[0]!.evidence).toHaveLength(3);
  });

  it('stays silent when the agent accepts the refusal', async () => {
    // One refused edit is the tool doing its job. The retry is the waste.
    const a = editCall('/repo/src/api.ts');
    expect(await run([a, failure(a, HARNESS.notRead)])).toEqual([]);
  });

  it('stays silent when the retry is to a different file', async () => {
    const a = editCall('/repo/src/api.ts');
    expect(await run([a, failure(a, HARNESS.notRead), editCall('/repo/src/other.ts')])).toEqual([]);
  });

  it('never blames the person for declining', async () => {
    // Their control, working as intended.
    const a = editCall('/repo/src/api.ts');
    expect(await run([a, failure(a, HARNESS.denied), editCall('/repo/src/api.ts')])).toEqual([]);
  });

  it("never blames the person's own hook for blocking an edit", async () => {
    // Calling someone's own safety rail a problem is worse than saying nothing.
    const a = editCall('/repo/src/api.ts');
    expect(await run([a, failure(a, HARNESS.hook), editCall('/repo/src/api.ts')])).toEqual([]);
  });

  it('counts instances, not the turns cited for them', async () => {
    const a = editCall('/repo/src/api.ts');
    const b = editCall('/repo/src/api.ts');
    const f = await run([
      a,
      failure(a, HARNESS.notRead),
      b,
      failure(b, HARNESS.stale),
      editCall('/repo/src/api.ts'),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.occurrences).toBe(2); // two refusals, one subject
  });

  it('tallies the harness reasons, summing to the occurrence count', async () => {
    const a = editCall('/repo/src/api.ts');
    const b = editCall('/repo/src/api.ts');
    const c = editCall('/repo/src/api.ts');
    const f = await run([
      a,
      failure(a, HARNESS.notRead),
      b,
      failure(b, HARNESS.notRead),
      c,
      failure(c, HARNESS.ambiguous),
      editCall('/repo/src/api.ts'),
    ]);
    expect(f[0]!.reasons).toEqual({ 'not-read-first': 2, 'ambiguous-target': 1 });
    const tallied = Object.values(f[0]!.reasons as Record<string, number>).reduce((x, y) => x + y, 0);
    expect(tallied).toBe(f[0]!.occurrences);
  });

  it('still fires when the harness reword leaves the reason unknown', async () => {
    // A new message costs a label, never the detection.
    const a = editCall('/repo/src/api.ts');
    const f = await run([a, failure(a, HARNESS.reworded), editCall('/repo/src/api.ts')]);
    expect(f).toHaveLength(1);
    expect(f[0]!.reasons).toBeUndefined();
  });

  it('does not blame the agent when a sibling call cancelled its edit', async () => {
    // The edit never ran, so re-issuing it is correct.
    const a = editCall('/repo/src/api.ts');
    expect(failureKindOf(HARNESS.cascade)).toBe('cascade');
    expect(await run([a, failure(a, HARNESS.cascade), editCall('/repo/src/api.ts')])).toEqual([]);
  });

  it("does not blame the agent for the person's own deny rule", async () => {
    // Inside the harness envelope, but the rejecter is the person's settings.
    const a = editCall('/repo/src/secrets.ts');
    expect(failureKindOf(HARNESS.denyRule)).toBe('permission');
    expect(await run([a, failure(a, HARNESS.denyRule), editCall('/repo/src/secrets.ts')])).toEqual([]);
  });

  it('pairs a verdict with the call BEFORE it when an id is reused', async () => {
    // Tool-call ids are not unique: a result binds to the nearest call before it, not the last with that id.
    const first = ev({
      turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/a.ts',
      toolCallId: 'reused', argHash: hash('first'), seq: 10,
    });
    const verdict = ev({
      turnType: 'tool_result', toolCallId: 'reused', isError: true,
      failureKind: 'tool', textSummary: HARNESS.notRead, seq: 11,
    });
    const retry = ev({
      turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/a.ts',
      toolCallId: 'reused', argHash: hash('retry'), seq: 12,
    });
    const hits = retriedFailures([first, verdict, retry]);
    expect(hits).toHaveLength(1);
    // The verdict belongs to the call that preceded it, never the later one.
    expect(hits[0]!.failure.seq).toBe(10);
    expect(hits[0]!.result.seq).toBe(11);
    expect(hits[0]!.retry.seq).toBe(12);
    expect(hits[0]!.failure.seq).toBeLessThan(hits[0]!.result.seq);
  });

  it('needs the retry to come after the verdict, not just after the attempt', async () => {
    // Otherwise a second edit sent before the harness answered would read as pushing on after a no.
    const a = ev({
      turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/a.ts',
      toolCallId: 'c1', argHash: hash('a'), seq: 10,
    });
    const sameBlock = ev({
      turnType: 'tool_use', toolName: 'Edit', filePath: '/repo/a.ts',
      toolCallId: 'c2', argHash: hash('b'), seq: 11,
    });
    const verdict = ev({
      turnType: 'tool_result', toolCallId: 'c1', isError: true,
      failureKind: 'tool', textSummary: HARNESS.notRead, seq: 12,
    });
    expect(retriedFailures([a, sameBlock, verdict])).toEqual([]);
  });

  it('ends the attempt at the next instruction from the person', async () => {
    // An edit after the person speaks again belongs to the next request.
    const a = editCall('/repo/src/api.ts');
    const f = await run([
      a,
      failure(a, HARNESS.notRead),
      ev({ turnType: 'user_prompt', textSummary: 'now do something else' }),
      editCall('/repo/src/api.ts'),
    ]);
    expect(f).toEqual([]);
  });

  it('reads the envelope, never the sentence inside it', async () => {
    // The envelope does the work: a known reason outside any envelope is not a finding.
    expect(failureKindOf(HARNESS.notRead)).toBe('tool');
    expect(failureKindOf(HARNESS.reworded)).toBe('tool');
    expect(failureKindOf(HARNESS.hook)).toBe('hook');
    expect(failureKindOf(HARNESS.denied)).toBe('denied');
    expect(failureKindOf('File has not been read yet.')).toBe('other');
  });

  it('names a reason only inside the harness envelope', async () => {
    // A file's own contents quoted back must not read as a harness verdict.
    const quoted = ev({
      turnType: 'tool_result',
      isError: true,
      failureKind: 'other',
      textSummary: '1\tFile has not been read yet. Read it first before writing to it.',
    });
    expect(reasonOf(quoted)).toBeUndefined();
  });

  it('gives every reason a line of advice', () => {
    // Every reason needs advice: CLAUDE.md allows evidence and something applicable.
    for (const text of [HARNESS.notRead, HARNESS.stale, HARNESS.ambiguous]) {
      const r = reasonOf(ev({ turnType: 'tool_result', isError: true, failureKind: 'tool', textSummary: text }));
      expect(r, text).toBeDefined();
      expect(adviceFor(r!).length).toBeGreaterThan(10);
    }
  });
});

describe('redundant_call — same call, same answer, nothing changed between', () => {
  /** A result carrying a real digest over its full output, as the parser makes. */
  const answer = (callId: string, text: string, at?: string): Event =>
    ev({
      turnType: 'tool_result',
      toolCallId: callId,
      textSummary: text,
      ...(at !== undefined ? { ts: at } : {}),
      ...(outputDigest(text) !== undefined ? { outHash: outputDigest(text) as string } : {}),
    });

  let callN = 0;
  const call = (args: string, at?: string, over: Partial<Event> = {}): Event => {
    callN += 1;
    return ev({
      turnType: 'tool_use',
      toolName: 'Bash',
      command: args,
      argHash: hash(args),
      toolCallId: `c${callN}`,
      ...(at !== undefined ? { ts: at } : {}),
      ...over,
    });
  };

  /** Seconds after a fixed start, so gaps are explicit in each test. */
  const at = (s: number): string => new Date(Date.parse('2026-10-19T12:00:00Z') + s * 1000).toISOString();

  const run = async (events: Event[]): Promise<Finding[]> =>
    (
      await runDetectors({
        events,
        session: facts(),
        detectors: [redundantCall()],
        now: '2026-10-19T00:00:00.000Z',
      })
    ).findings;

  /** Three identical calls, seconds apart, with identical answers. */
  const tightRun = (cmd: string, text: string): Event[] => {
    const out: Event[] = [];
    for (const [i, t] of [0, 3, 6].entries()) {
      const c = call(cmd, at(t));
      out.push(c, answer(c.toolCallId as string, text, at(t + 1)));
      void i;
    }
    return out;
  };

  it('fires on three identical calls with identical answers', async () => {
    const f = await run(tightRun('npx tsc --noEmit', 'error TS2304: Cannot find name'));
    expect(f).toHaveLength(1);
    expect(f[0]!.occurrences).toBe(3);
    expect(f[0]!.confidence).toBe('certain');
  });

  it('sees a repeat spread across the session, not only consecutive ones', async () => {
    // A repeat with unrelated work between is still a repeat: aggregated, not consecutive.
    const events: Event[] = [];
    for (const t of [0, 20, 40]) {
      const c = call('go generate', at(t));
      events.push(c, answer(c.toolCallId as string, 'Exit: 0', at(t + 1)));
      // unrelated, non-mutating work in between
      events.push(ev({ turnType: 'tool_use', toolName: 'Grep', pattern: 'x', argHash: hash(`g${t}`) }));
    }
    const f = await run(events);
    expect(f).toHaveLength(1);
    expect(f[0]!.occurrences).toBe(3);
  });

  it('reconciles two actors into one session finding', async () => {
    // Redundant with respect to the session, not one actor's slice.
    const events: Event[] = [];
    for (const [i, t] of [0, 5, 10].entries()) {
      const sc = i % 2 === 1 ? { isSidechain: true, sidechainId: 'sc1' } : {};
      const c = call('npm test', at(t), sc);
      events.push(c, answer(c.toolCallId as string, 'FAIL x2', at(t + 1)));
    }
    const f = await run(events);
    expect(f).toHaveLength(1);
    expect(f[0]!.occurrences).toBe(3);
    // and the evidence reads in transcript order, not grouped by actor
    const seqs = f[0]!.evidence.map((e) => e.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  /** Insert an event between the first and last call. The guard reads `seq`, not array position. */
  const between = (events: Event[], e: Event): Event[] => {
    const calls = events.filter((x) => x.turnType === 'tool_use');
    const mid = ((calls[0] as Event).seq + (calls[1] as Event).seq) / 2;
    return [...events, { ...e, seq: mid }];
  };

  it('does not fire when an edit happened between', async () => {
    // Re-running after a change is `fail_fix_fail`, not a redundant call.
    const events = between(
      tightRun('npm test', '2 failed'),
      ev({ turnType: 'tool_use', toolName: 'Edit', filePath: '/a.ts', argHash: hash('e') }),
    );
    expect(await run(events)).toEqual([]);
  });

  it('does not fire when a new instruction arrived between', async () => {
    const events = between(
      tightRun('ls', 'a.ts'),
      ev({ turnType: 'user_prompt', textSummary: 'now do something else' }),
    );
    expect(await run(events)).toEqual([]);
  });

  it('treats a slow repeat as waiting, not looping', async () => {
    // Polls (`sleep 60 && …`) separate from real repeats on the gap alone.
    const events: Event[] = [];
    for (const t of [0, 70, 140]) {
      const c = call('gh run view 123', at(t));
      events.push(c, answer(c.toolCallId as string, 'status: in_progress', at(t + 1)));
    }
    expect(await run(events)).toEqual([]);
  });

  it('reads a changing answer as progress, not a loop', async () => {
    const events: Event[] = [];
    for (const [i, t] of [0, 3, 6].entries()) {
      const c = call('npm test', at(t));
      events.push(c, answer(c.toolCallId as string, `Tests: ${3 - i} failed`, at(t + 1)));
    }
    expect(await run(events)).toEqual([]);
  });

  it('will not call an unseen answer identical', async () => {
    // outHash is absent when output was empty or uncapturable.
    const events: Event[] = [];
    for (const t of [0, 3, 6]) {
      const c = call('ls', at(t));
      events.push(c, ev({ turnType: 'tool_result', toolCallId: c.toolCallId as string }));
    }
    expect(await run(events)).toEqual([]);
  });

  it('never treats a polling tool as a loop', async () => {
    // BashOutput on a finished job returns instantly and identically; only the name separates it.
    const events: Event[] = [];
    for (const t of [0, 2, 4]) {
      callN += 1;
      const c = ev({ turnType: 'tool_use', toolName: 'BashOutput', argHash: hash('job'), toolCallId: `p${callN}`, ts: at(t) });
      events.push(c, answer(c.toolCallId as string, 'running', at(t + 1)));
    }
    expect(await run(events)).toEqual([]);
  });

  it('downgrades to high when the command clipped its own output', async () => {
    const piped = 'npx tsc --noEmit 2>&1 | head -30';
    expect(truncatesOutput(piped)).toBe(true);
    const events: Event[] = [];
    for (const t of [0, 3, 6]) {
      const c = call(piped, at(t), { truncatesOwnOutput: true });
      events.push(c, answer(c.toolCallId as string, '30 lines', at(t + 1)));
    }
    const f = await run(events);
    expect(f).toHaveLength(1);
    expect(f[0]!.confidence).toBe('high');
  });

  it('is session-scoped, and ships in standard', () => {
    expect(redundantCall().scope).toBe('session');
    expect(redundantCall().preset).toBe('standard');
    expect(detectorsFor('core').map((d) => d.dimension)).not.toContain('redundant_call');
  });
});

describe('countDenominators — usage is counted once per response', () => {
  it('does not sum the same usage once per block', () => {
    // One response spans several records that repeat the same usage: count it once (`oncePerResponse`).
    const tokens = { input: 0, output: 500, cacheRead: 0, cacheCreation: 100 };
    const events = [1, 2, 3].map((n) => ({
      uuid: `u${n}`,
      sessionId: 's1',
      seq: n,
      turnType: 'assistant_msg' as const,
      responseId: 'msg_1',
      tokens,
    }));

    const d = countDenominators(events as never);
    expect(d.tokens.output).toBe(500);
    expect(d.tokens.cacheCreation).toBe(100);
  });

  it('is not fooled by two token-bearing events sharing a uuid', () => {
    // Uuids are duplicated too, so dedup must not key on uuid alone.
    const tokens = { input: 0, output: 500, cacheRead: 0, cacheCreation: 0 };
    const events = [
      { uuid: 'same', sessionId: 's1', seq: 1, turnType: 'assistant_msg' as const, responseId: 'a', tokens },
      { uuid: 'same', sessionId: 's1', seq: 2, turnType: 'assistant_msg' as const, responseId: 'b', tokens },
    ];
    // Two genuinely distinct responses that happen to share a uuid: 1000.
    expect(countDenominators(events as never).tokens.output).toBe(1000);
  });

  it('still counts records that genuinely stand alone', () => {
    const events = [1, 2].map((n) => ({
      uuid: `u${n}`,
      sessionId: 's1',
      seq: n,
      turnType: 'assistant_msg' as const,
      tokens: { input: 0, output: 10, cacheRead: 0, cacheCreation: 0 },
    }));
    // No responseId, so each falls back to its own uuid rather than collapsing.
    expect(countDenominators(events as never).tokens.output).toBe(20);
  });
});

describe('redundant_call — two is a repeat, but never for an edit', () => {
  let n = 0;
  const ev = (o: Record<string, unknown>) => {
    n += 1;
    return { uuid: `u${n}`, sessionId: 's1', seq: n, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...o };
  };
  const pair = (tool: string) => {
    n = 0;
    const out: unknown[] = [ev({ turnType: 'user_prompt' })];
    for (const id of ['a', 'b']) {
      out.push(
        ev({ turnType: 'tool_use', toolName: tool, toolCallId: id, filePath: '/f.ts', argHash: 'same' }),
        ev({ turnType: 'tool_result', toolCallId: id, isError: false, outHash: 'same', outBytes: 10 }),
        ev({ turnType: 'assistant_msg', responseId: `m${id}` }),
      );
    }
    return out as never[];
  };

  it('flags the same call twice with the same answer', () => {
    // Two is a repeat.
    const groups = repeatGroups(pair('Read')).filter((g) => isRedundant(g, pair('Read')));
    expect(groups.length).toBe(1);
  });

  it('never flags a repeated edit, whatever the count', () => {
    // An edit's output is the file's new contents, so "same answer" does not mean nothing happened.
    for (const tool of ['Edit', 'Write']) {
      const events = pair(tool);
      expect(repeatGroups(events).filter((g) => isRedundant(g, events)).length).toBe(0);
    }
  });

  it('never pairs a call with itself when an id is reused', () => {
    // Tool-call ids are not unique: two results bound to one call must not count as a repeat.
    n = 0;
    const call = ev({ turnType: 'tool_use', toolName: 'Read', toolCallId: 'dup', filePath: '/f.ts', argHash: 'same' });
    const events = [
      call,
      ev({ turnType: 'tool_result', toolCallId: 'dup', isError: false, outHash: 'same', outBytes: 10 }),
      ev({ turnType: 'tool_result', toolCallId: 'dup', isError: false, outHash: 'same', outBytes: 10 }),
    ] as never[];
    expect(repeatGroups(events).filter((g) => isRedundant(g, events))).toHaveLength(0);
  });

  it('keeps every guard that made it precise', () => {
    // An edit between the calls still disqualifies a non-edit repeat.
    const events = pair('Read');
    events.splice(4, 0, {
      uuid: 'mid', sessionId: 's1', seq: 3.5, turnType: 'tool_use', toolName: 'Edit', filePath: '/x.ts',
    } as never);
    expect(repeatGroups(events).filter((g) => isRedundant(g, events)).length).toBe(0);
  });
});
