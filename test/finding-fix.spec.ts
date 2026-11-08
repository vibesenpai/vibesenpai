// A finding's own fix: each rung of the ladder, the precision gates that keep a rung from firing, and fix identity.

import { describe, expect, it } from 'vitest';
import type { Event } from '../src/types.ts';
import type { JudgedFinding } from '../src/judge/state.ts';
import { commandHeads, findingRules, fixForFinding, forbids, questionCommand, questionThenEdit, sharedFixes, type FindingContext, type FindingFix } from '../src/finding-fix.ts';
import { ownedByHarness } from '../src/harness/claude-code.ts';

const ev = (seq: number, o: Partial<Event> & Pick<Event, 'turnType'>): Event =>
  ({ uuid: `u${seq}`, sessionId: 's1', harness: 'claude-code', parentUuid: null, isSidechain: false, seq, ...o }) as Event;
const prompt = (seq: number, text: string): Event => ev(seq, { turnType: 'user_prompt', textSummary: text });
const bash = (seq: number, command: string): Event => ev(seq, { turnType: 'tool_use', toolName: 'Bash', command });
const edit = (seq: number, filePath: string): Event => ev(seq, { turnType: 'tool_use', toolName: 'Edit', filePath });

const finding = (o: Partial<JudgedFinding> = {}): JudgedFinding => ({
  sessionId: 's1',
  dimension: 'constraint_violation',
  turns: [10],
  quote: 'yeah my constraint still remains. don\'t push!',
  why: 'pushed anyway',
  at: '2026-10-20T00:00:00.000Z',
  ...o,
});
const ctx = (events: Event[], o: Partial<FindingContext> = {}): FindingContext => ({
  events,
  project: '-Users-me-repo',
  cwd: '~/repo',
  author: 'developer',
  ownedByHarness,
  ...o,
});

describe('command heads', () => {
  it('splits chained commands and skips options, env assignments and heredoc bodies', () => {
    expect(commandHeads('npx vitest run && git -c user.name=x commit -m y && git push')).toEqual(['npx vitest', 'git commit', 'git push']);
    expect(commandHeads("cat > f.md <<'EOF'\nthen git push the branch\nEOF\nls")).toEqual(['cat', 'ls']);
    expect(commandHeads('FOO=1 node -e "x"')).toEqual(['node']);
  });

  it('keeps only plain lowercase words, so no argument with content survives', () => {
    expect(commandHeads('curl https://example.com/?token=abc')).toEqual(['curl']);
    expect(commandHeads('echo $SECRET')).toEqual(['echo']);
  });
});

describe('a prohibition, not a mention', () => {
  it('reads a negation before the verb, or "without" after it', () => {
    expect(forbids("don't push!", 'push')).toBe(true);
    expect(forbids('I DO NOT like when you push without my consent', 'push')).toBe(true);
    expect(forbids('never pushing to main', 'push')).toBe(true);
  });

  it('ignores a verb merely mentioned', () => {
    expect(forbids('Lets enter plan mode for that', 'for')).toBe(false);
    expect(forbids('"Spent since Oct 29" - is this just today?', 'spent')).toBe(false);
    expect(forbids('push it when ready', 'push')).toBe(false);
  });
});

describe('the ladder', () => {
  it('1. a forbidden command run in the window becomes a permission rule', () => {
    const events = [prompt(1, 'tidy up'), bash(5, 'npm test && git push'), prompt(10, "don't push!")];
    const x = fixForFinding(finding(), ctx(events));
    expect(x).toMatchObject({ kind: 'permission', target: 'project-permissions', text: 'git push', key: 'action:git push', applicable: true });
    expect(x?.source.quote).toBe("yeah my constraint still remains. don't push!");
  });

  it('1. not when the quote is the agent\'s own words', () => {
    const events = [prompt(1, 'tidy up'), bash(5, 'git push'), prompt(10, 'x')];
    expect(fixForFinding(finding(), ctx(events, { author: 'agent' }))).toBeUndefined();
  });

  it('1. not when the command ran outside the window', () => {
    const events = [bash(0, 'git push'), prompt(1, 'tidy up'), prompt(10, "don't push!")];
    expect(fixForFinding(finding(), ctx(events))?.kind).not.toBe('permission');
  });

  it('3. a write outside the project becomes a guard on that path', () => {
    const events = [prompt(1, 'plan first'), edit(4, '~/.claude.json'), prompt(10, 'why did you edit that')];
    const x = fixForFinding(finding({ quote: 'why did you edit that' }), ctx(events));
    expect(x).toMatchObject({ kind: 'guard', target: 'project-hooks', text: '~/.claude.json', key: 'path:~/.claude.json' });
  });

  it('3. never on a path the harness writes for itself, or without a known working directory', () => {
    const plans = [prompt(1, 'a'), edit(4, '~/.claude/plans/x.md'), prompt(10, 'b')];
    expect(fixForFinding(finding({ quote: 'b' }), ctx(plans))).toBeUndefined();
    const outside = [prompt(1, 'a'), edit(4, '~/.claude.json'), prompt(10, 'b')];
    const { cwd: _, ...noCwd } = ctx(outside);
    expect(fixForFinding(finding({ quote: 'b' }), noCwd)).toBeUndefined();
  });

  it('6. a broken loaded instruction asks for a check, not another line', () => {
    const f = finding({ quote: 'b', established: { source: 'instruction', quote: 'Never write the user\'s config.', from: 'CLAUDE.md' } });
    const x = fixForFinding(f, ctx([prompt(1, 'a'), prompt(10, 'b')]));
    expect(x).toMatchObject({ kind: 'check', target: 'project-check', text: "Never write the user's config.", source: { from: 'CLAUDE.md' } });
  });

  it('7. a claim over a failure nothing fixed is a Stop hook, printed only', () => {
    const events = [
      prompt(1, 'update the docs'),
      ev(3, { turnType: 'tool_result', toolName: 'Edit', filePath: '~/repo/a.md', isError: true }),
      prompt(10, 'one file failed'),
    ];
    const x = fixForFinding(finding({ dimension: 'inaccurate_self_report', quote: 'all done' }), ctx(events, { author: 'agent' }));
    expect(x).toMatchObject({ kind: 'hook', applicable: false });
  });

  it('7. not when a later success fixed it', () => {
    const events = [
      prompt(1, 'update the docs'),
      ev(3, { turnType: 'tool_result', toolName: 'Edit', filePath: '~/repo/a.md', isError: true }),
      ev(5, { turnType: 'tool_result', toolName: 'Edit', filePath: '~/repo/a.md' }),
      prompt(10, 'x'),
    ];
    expect(fixForFinding(finding({ dimension: 'inaccurate_self_report', quote: 'all done' }), ctx(events, { author: 'agent' }))).toBeUndefined();
  });

  it('5. an earlier expectation, scoped to the files written in spite of it', () => {
    const f = finding({ quote: 'b', turns: [10], established: { source: 'turn', quote: "We can't show fix before showing the problem.", turn: 2 } });
    const events = [prompt(1, 'a'), prompt(2, "We can't show fix before showing the problem."), edit(5, '~/repo/hooks/pane.tsx'), prompt(10, 'b')];
    const x = fixForFinding(f, ctx(events));
    expect(x).toMatchObject({ kind: 'scoped-rule', target: 'scoped-instructions', paths: ['hooks/pane.tsx'] });
    expect(x?.text).toBe('- Standing instruction from the developer: "We can\'t show fix before showing the problem."');
  });

  it('a plain rule when no files were written; nothing from a reaction alone', () => {
    const f = finding({ quote: 'b', established: { source: 'turn', quote: 'Keep the plan safe.', turn: 2 } });
    expect(fixForFinding(f, ctx([prompt(1, 'a'), prompt(10, 'b')]))?.kind).toBe('rule');
    expect(fixForFinding(finding({ quote: 'Also clicking Apply did nothing' }), ctx([prompt(1, 'a'), prompt(10, 'b')]))).toBeUndefined();
  });

  it('a developer-reference is never a rule: it is the reaction, not the expectation', () => {
    const f = finding({ quote: 'b', established: { source: 'developer-reference', quote: 'I had asked you to drop the numbers' } });
    expect(fixForFinding(f, ctx([prompt(1, 'a'), prompt(10, 'b')]))).toBeUndefined();
  });
});

describe('identity and grouping', () => {
  it('keys on what the fix is for, so rewording keeps the id and two constraints in a dimension differ', () => {
    const events = [prompt(1, 'a'), bash(5, 'git push'), prompt(10, 'b')];
    const one = fixForFinding(finding({ quote: "don't push!" }), ctx(events)) as FindingFix;
    const two = fixForFinding(finding({ quote: 'never pushing without asking' }), ctx(events)) as FindingFix;
    expect(one.fixId).toBe(two.fixId);
    const rule = fixForFinding(finding({ quote: 'b', established: { source: 'turn', quote: 'Keep it short.', turn: 1 } }), ctx([prompt(1, 'a'), prompt(10, 'b')])) as FindingFix;
    expect(rule.fixId).not.toBe(one.fixId);
  });

  it('shares a fix only across two or more sessions, and never by quote', () => {
    const mk = (sessionId: string, key: string): FindingFix =>
      ({ fixId: key, dimension: 'constraint_violation', kind: 'permission', target: 'project-permissions', key, text: '', source: { quote: '' }, sessionId, turns: [1], project: 'p', applicable: true });
    expect(sharedFixes([mk('a', 'action:git push'), mk('a', 'action:git push')])).toEqual([]);
    expect(sharedFixes([mk('a', 'action:git push'), mk('b', 'action:git push')])).toMatchObject([{ sessions: 2, findings: 2 }]);
    expect(sharedFixes([mk('a', 'quote:1'), mk('b', 'quote:1')])).toEqual([]);
  });

  it('a question answered with an edit, in two sessions, is the read-only subagent', () => {
    const events = [prompt(1, 'how do I run the pane tests?'), edit(3, '~/repo/test/x.ts'), prompt(10, 'I only asked')];
    const f = finding({ dimension: 'overreach', quote: 'I only asked', turns: [3, 10] });
    expect(questionThenEdit(f, events)).toBe(true);
    expect(questionThenEdit(f, [prompt(1, 'run the pane tests'), edit(3, '~/repo/test/x.ts'), prompt(10, 'x')])).toBe(false);
    expect(questionCommand([{ finding: f, project: 'p' }])).toBeUndefined();
    expect(questionCommand([{ finding: f, project: 'p' }, { finding: { ...f, sessionId: 's2' }, project: 'p' }])?.fix).toMatchObject({ kind: 'agent', target: 'project-agent' });
  });
});

describe('rules to look for in later sessions', () => {
  it('are the expectations set in a turn, once each, as the rule line Apply would add', () => {
    const set = (quote: string): JudgedFinding => finding({ established: { source: 'turn', quote, turn: 1 } });
    expect(findingRules([set('Keep it short.'), set('Keep it short.'), finding(), set('x'.repeat(300))])).toEqual([
      '- Standing instruction from the developer: "Keep it short."',
    ]);
  });
});
