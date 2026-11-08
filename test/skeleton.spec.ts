import { describe, expect, it } from 'vitest';
import { parseTranscriptText } from '../src/parsers/claude-code.ts';
import { buildSkeletons, toLines, renderSkeleton, estimateTokens } from '../src/skeleton.ts';
import { SCHEMA } from '../src/schema.ts';
import type { Event, SkeletonLine } from '../src/types.ts';

const j = (o: unknown): string => JSON.stringify(o);

/** Minimal Event, so each test states only the fields it cares about. */
function ev(over: Partial<Event> & Pick<Event, 'turnType'>): Event {
  return {
    sessionId: 's1',
    harness: 'claude-code',
    uuid: over.uuid ?? 'u1',
    parentUuid: null,
    seq: over.seq ?? 0,
    isSidechain: false,
    ts: '2026-10-17T00:00:00.000Z',
    ...over,
  } as Event;
}

const kinds = (ls: SkeletonLine[]): string[] =>
  ls.map((l) => (l.k === 'meta' ? `meta:${l.kind}` : l.k));

describe('skeleton — line mapping', () => {
  it('maps each turn type to its line kind', () => {
    const { lines } = toLines([
      ev({ turnType: 'user_prompt', uuid: 'a', textSummary: 'fix the login bug' }),
      ev({ turnType: 'assistant_msg', uuid: 'b', textSummary: 'looking' }),
      ev({ turnType: 'tool_use', uuid: 'c', toolName: 'Read', filePath: 'auth.ts' }),
      ev({ turnType: 'queue_operation', uuid: 'd' }),
      ev({ turnType: 'system', uuid: 'e', systemKind: 'compaction' }),
    ]);
    expect(kinds(lines)).toEqual(['user', 'assist', 'tool', 'meta:interrupt', 'meta:compaction']);
  });

  it('folds a SUCCESSFUL tool result into its tool line', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Read', filePath: 'auth.ts' }),
      ev({ turnType: 'tool_result', uuid: 'b', toolCallId: 't1', exitCode: 0 }),
    ]);
    expect(kinds(lines)).toEqual(['tool']);
  });

  it('gives a FAILED result its own line — failure is the signal', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Bash', command: 'npm test' }),
      ev({ turnType: 'tool_result', uuid: 'b', isError: true, textSummary: 'FAIL token undefined' }),
    ]);
    expect(kinds(lines)).toEqual(['tool', 'result']);
    expect(lines[1]).toMatchObject({ k: 'result', ok: false, err: 'FAIL token undefined' });
  });

  it('treats a non-zero exit code as a failure even without isError', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_result', uuid: 'a', exitCode: 1, textSummary: 'exit 1' }),
    ]);
    expect(kinds(lines)).toEqual(['result']);
  });

  it('promotes a git commit and a revert to meta lines', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Bash', command: 'git commit -m "fix"' }),
      ev({ turnType: 'tool_use', uuid: 'b', toolName: 'Bash', command: 'git reset --hard HEAD~1' }),
      ev({ turnType: 'tool_use', uuid: 'c', toolName: 'Bash', command: 'git status' }),
    ]);
    expect(kinds(lines)).toEqual(['meta:commit', 'meta:revert', 'tool']);
  });

  it('keeps enough of a command to tell two invocations apart', () => {
    // Two words once collapsed distinct `uv run <script>` calls into one target.
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Bash', command: 'uv run scripts/ingest.py' }),
      ev({ turnType: 'tool_use', uuid: 'b', toolName: 'Bash', command: 'uv run scripts/report.py' }),
    ]);
    expect(lines[0]).toMatchObject({ target: 'uv run scripts/ingest.py' });
    expect(lines[1]).toMatchObject({ target: 'uv run scripts/report.py' });
  });

  it('strips leading shell punctuation from a compound command', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Bash', command: '(source .venv/bin/activate && pytest)' }),
    ]);
    expect(lines[0]).toMatchObject({ target: expect.stringMatching(/^source/) as unknown as string });
  });

  it('caps a long command on a word boundary', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Bash', command: `echo ${'word '.repeat(40)}` }),
    ]);
    const target = (lines[0] as { target: string }).target;
    expect(target.length).toBeLessThanOrEqual(50);
    expect(target).toMatch(/…$/);
    expect(target).not.toMatch(/\s…$/); // cut cleanly, no dangling space
  });

  it('takes only the first line of a multi-line command', () => {
    const { lines } = toLines([
      ev({ turnType: 'tool_use', uuid: 'a', toolName: 'Bash', command: 'cat <<EOF\nsecret body\nEOF' }),
    ]);
    expect((lines[0] as { target: string }).target).toBe('cat <<EOF');
  });

  it('drops an assistant record carrying no text', () => {
    // It would render as a bare `A  …`; its tool calls have their own lines.
    const { lines, dropped } = toLines([
      ev({ turnType: 'assistant_msg', uuid: 'a' }),
      ev({ turnType: 'assistant_msg', uuid: 'b', textSummary: 'actually saying something' }),
    ]);
    expect(kinds(lines)).toEqual(['assist']);
    expect(dropped['assistant_msg:no-text']).toBe(1);
  });

  it('counts unrepresented types instead of discarding them silently', () => {
    const { lines, dropped } = toLines([
      ev({ turnType: 'system', uuid: 'a', systemKind: 'cost-state' }),
      ev({ turnType: 'local_command', uuid: 'b' }),
    ]);
    expect(lines).toHaveLength(0);
    expect(dropped).toEqual({ 'system:cost-state': 1, local_command: 1 });
  });

  it('carries the abandoned flag onto the line', () => {
    // Abandoned work is flagged, never dropped.
    const { lines } = toLines([
      ev({ turnType: 'user_prompt', uuid: 'a', textSummary: 'try again', abandoned: true }),
    ]);
    expect(lines[0]).toMatchObject({ abandoned: true });
    expect(renderSkeleton({ ...stampLike(), sessionId: 's1', window: w(), lines })).toContain('[abandoned]');
  });
});

function stampLike() {
  return { tool: 'vibesenpai', schema: 'skeleton', v: SCHEMA.skeleton } as const;
}
function w() {
  return { from: { uuid: 'a', sessionId: 's1' }, to: { uuid: 'a', sessionId: 's1' } };
}

describe('skeleton — windowing', () => {
  const many = (n: number): Event[] =>
    Array.from({ length: n }, (_, i) =>
      ev({ turnType: 'tool_use', uuid: `u${i}`, seq: i, toolName: 'Read', filePath: `f${i}.ts` }),
    );

  it('does not overlap by default', () => {
    const sk = buildSkeletons('s1', many(24), { width: 12 });
    expect(sk).toHaveLength(2);
    expect(sk[0]!.lines).toHaveLength(12);
    expect(sk[0]!.window.from.uuid).toBe('u0');
    expect(sk[1]!.window.from.uuid).toBe('u12');
  });

  it('emits a short final window rather than dropping the tail', () => {
    const sk = buildSkeletons('s1', many(15), { width: 12 });
    expect(sk).toHaveLength(2);
    expect(sk[1]!.lines).toHaveLength(3);
  });

  it('overlaps when asked, without re-emitting a fully covered tail', () => {
    const sk = buildSkeletons('s1', many(18), { width: 12, stride: 6 });
    expect(sk.map((s) => s.window.from.uuid)).toEqual(['u0', 'u6']);
    // u6..u17 is the last window; a third starting at u12 would be a subset.
    expect(sk.at(-1)!.window.to.uuid).toBe('u17');
  });

  it('anchors the window on uuids, never positions', () => {
    const sk = buildSkeletons('s1', many(5), { width: 12 });
    expect(sk[0]!.window.from).toMatchObject({ uuid: 'u0', sessionId: 's1' });
    expect(sk[0]!.window.to).toMatchObject({ uuid: 'u4' });
  });

  it('is versioned and self-describing', () => {
    const sk = buildSkeletons('s1', many(3));
    expect(sk[0]).toMatchObject({ tool: 'vibesenpai', schema: 'skeleton', v: SCHEMA.skeleton });
  });

  it('produces nothing from events that yield no lines', () => {
    expect(buildSkeletons('s1', [ev({ turnType: 'local_command', uuid: 'a' })])).toEqual([]);
  });

  it('rejects a nonsensical width', () => {
    expect(() => buildSkeletons('s1', many(3), { width: 0 })).toThrow(RangeError);
  });
});

describe('skeleton — sidechains get their own windows', () => {
  it('separates a subagent thread from the main thread', () => {
    const events = [
      ev({ turnType: 'user_prompt', uuid: 'a', seq: 0, textSummary: 'go' }),
      ev({ turnType: 'tool_use', uuid: 'b', seq: 1, isSidechain: true, sidechainId: 'sc1', toolName: 'Read', filePath: 'x.ts' }),
      ev({ turnType: 'tool_use', uuid: 'c', seq: 2, isSidechain: true, sidechainId: 'sc2', toolName: 'Read', filePath: 'y.ts' }),
      ev({ turnType: 'tool_use', uuid: 'd', seq: 3, toolName: 'Edit', filePath: 'z.ts' }),
    ];
    const sk = buildSkeletons('s1', events);
    expect(sk).toHaveLength(3);
    const main = sk.find((s) => s.sidechainId === undefined)!;
    expect(main.lines.map((l) => l.ref.uuid)).toEqual(['a', 'd']);
    expect(sk.filter((s) => s.sidechainId !== undefined).map((s) => s.sidechainId).sort())
      .toEqual(['sc1', 'sc2']);
  });
});

describe('skeleton — token budget, with elision recorded', () => {
  // Short lines never hit 2K tokens on real data, so this path needs a forced test.
  const huge = 'x'.repeat(8000);

  it('elides to get under budget and records that it did', () => {
    const events = [
      ev({ turnType: 'user_prompt', uuid: 'a', seq: 0, textSummary: 'fix it' }),
      ev({ turnType: 'assistant_msg', uuid: 'b', seq: 1, textSummary: huge }),
      ev({ turnType: 'tool_use', uuid: 'c', seq: 2, toolName: 'Edit', filePath: 'auth.ts' }),
    ];
    const sk = buildSkeletons('s1', events, { tokenBudget: 200 })[0]!;
    expect(sk.elided).toBeDefined();
    expect(estimateTokens(renderSkeleton(sk))).toBeLessThanOrEqual(260); // budget + the notice
  });

  it('never drops a user prompt or a failure to save budget', () => {
    const events = [
      ev({ turnType: 'user_prompt', uuid: 'a', seq: 0, textSummary: 'the decisive turn' }),
      ev({ turnType: 'assistant_msg', uuid: 'b', seq: 1, textSummary: huge }),
      ev({ turnType: 'tool_result', uuid: 'c', seq: 2, isError: true, textSummary: 'FAIL here' }),
    ];
    const sk = buildSkeletons('s1', events, { tokenBudget: 50 })[0]!;
    expect(kinds(sk.lines)).toContain('user');
    expect(kinds(sk.lines)).toContain('result');
    expect(renderSkeleton(sk)).toContain('the decisive turn');
    expect(renderSkeleton(sk)).toContain('FAIL here');
  });

  it('prints the elision rather than hiding it', () => {
    const events = [
      ev({ turnType: 'user_prompt', uuid: 'a', seq: 0, textSummary: 'go' }),
      ev({ turnType: 'assistant_msg', uuid: 'b', seq: 1, textSummary: huge }),
    ];
    const sk = buildSkeletons('s1', events, { tokenBudget: 20 })[0]!;
    expect(renderSkeleton(sk)).toMatch(/shortened or dropped \(token-budget\)/);
  });

  it('leaves a window under budget completely alone', () => {
    const sk = buildSkeletons('s1', [
      ev({ turnType: 'user_prompt', uuid: 'a', textSummary: 'short' }),
    ])[0]!;
    expect(sk.elided).toBeUndefined();
  });
});

describe('skeleton — rendering', () => {
  it('renders the shape the contract documents', () => {
    const text = [
      j({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'fix the login bug' } }),
      j({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'auth.ts' } }] } }),
      j({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      j({ type: 'assistant', uuid: 'd', parentUuid: 'c', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }),
      j({ type: 'user', uuid: 'e', parentUuid: 'd', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'FAIL: token undefined' }] } }),
    ].join('\n');

    const r = parseTranscriptText(text);
    const out = renderSkeleton(buildSkeletons('s1', r.events)[0]!);

    expect(out).toContain('U  fix the login bug');
    expect(out).toContain('→  Read auth.ts');
    expect(out).toContain('→  Bash npm test');
    expect(out).toMatch(/✗ {2}.*FAIL/);
    // The successful read produced no result line.
    expect(out.split('\n').filter((l) => l.startsWith('✗'))).toHaveLength(1);
  });
});

describe('skeleton — compression is measured, not assumed', () => {
  it('reduces a realistic session to well under 10% of the raw JSONL', () => {
    // Rendered bytes over whole raw JSONL bytes, the same denominator as scripts/verify-corpus.ts.
    const records: string[] = [
      j({ type: 'user', uuid: 'p', parentUuid: null, message: { content: 'refactor the auth module and make the tests pass' } }),
    ];
    let prev = 'p';
    for (let i = 0; i < 20; i++) {
      const tu = `tu${i}`, tr = `tr${i}`;
      records.push(
        j({
          type: 'assistant', uuid: tu, parentUuid: prev,
          message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `src/mod${i}.ts` } }] },
        }),
        j({
          type: 'user', uuid: tr, parentUuid: tu,
          // Real tool results are large; this is the bulk a skeleton exists to strip.
          message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'export const x = 1;\n'.repeat(60) }] },
        }),
      );
      prev = tr;
    }
    const text = records.join('\n');

    const r = parseTranscriptText(text);
    const rendered = buildSkeletons('s1', r.events).map(renderSkeleton).join('\n');
    const ratio = Buffer.byteLength(rendered) / Buffer.byteLength(text);

    expect(r.events.length).toBeGreaterThan(40);
    expect(ratio).toBeLessThan(0.10);
  });

  it('estimates tokens at roughly four characters each', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

describe('skeleton — per-window accounting', () => {
  // Through buildSkeletons, not toLines, to catch per-window attribution.
  const threadWithDrops = (): Event[] => {
    const out: Event[] = [];
    for (let i = 0; i < 24; i++) {
      out.push(ev({ turnType: 'tool_use', uuid: `u${i}`, seq: i * 2, toolName: 'Read', filePath: `f${i}.ts` }));
      // One unrepresented record between every pair of lines.
      out.push(ev({ turnType: 'system', uuid: `s${i}`, seq: i * 2 + 1, systemKind: 'cost-state' }));
    }
    return out;
  };

  it('counts drops per window, not once per thread', () => {
    const sk = buildSkeletons('s1', threadWithDrops(), { width: 12 });
    expect(sk).toHaveLength(2);
    // Each drop belongs to the line it precedes; the trailing drop joins the final window.
    expect(sk[0]!.dropped?.['system:cost-state']).toBe(11);
    expect(sk[1]!.dropped?.['system:cost-state']).toBe(13);
    expect(sk[0]!.dropped?.['system:cost-state']).not.toBe(24);
  });

  it('sums across windows back to the thread total', () => {
    const events = threadWithDrops();
    const total = toLines(events).dropped['system:cost-state'];
    const summed = buildSkeletons('s1', events, { width: 12 })
      .reduce((n, s) => n + (s.dropped?.['system:cost-state'] ?? 0), 0);
    expect(summed).toBe(total);
    expect(summed).toBe(24);
  });

  it('gives each window its own object, not a shared reference', () => {
    const sk = buildSkeletons('s1', threadWithDrops(), { width: 12 });
    expect(sk[0]!.dropped).not.toBe(sk[1]!.dropped);
  });

  it('attributes a trailing drop to the window that ends the thread', () => {
    const sk = buildSkeletons('s1', [
      ev({ turnType: 'tool_use', uuid: 'a', seq: 0, toolName: 'Read', filePath: 'x.ts' }),
      ev({ turnType: 'local_command', uuid: 'b', seq: 1 }),
    ]);
    expect(sk[0]!.dropped).toEqual({ local_command: 1 });
  });

  it('reports a non-zero elided count when only prose was stripped', () => {
    // The first budget pass strips prose without removing lines.
    const sk = buildSkeletons('s1', [
      ev({ turnType: 'user_prompt', uuid: 'a', seq: 0, textSummary: 'go' }),
      ev({ turnType: 'assistant_msg', uuid: 'b', seq: 1, textSummary: 'y'.repeat(4000) }),
    ], { tokenBudget: 60 })[0]!;
    expect(sk.elided!.lines).toBeGreaterThan(0);
    expect(renderSkeleton(sk)).not.toContain('0 line(s)');
  });
});
