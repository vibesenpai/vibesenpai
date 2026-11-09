/**
 * A judged finding's own fix, parameterised from its evidence: the command, paths or words behind it.
 * Pure. Text is read only to fill in a finding that already exists, never to decide one. The ladder: docs/artifacts.md.
 */

import { createHash } from 'node:crypto';
import type { Event } from './types.ts';
import type { JudgedFinding } from './judge/state.ts';
import { openFailuresBefore } from './judge/packet.ts';
import { fixIdOf, type ApplyPlan, type ApplyTarget } from './fix.ts';

export type FixKind = 'permission' | 'guard' | 'check' | 'scoped-rule' | 'rule' | 'hook' | 'agent';

export type FindingFix = {
  fixId: string;
  dimension: string;
  kind: FixKind;
  target: ApplyTarget;
  /** What the fix is for, never its wording: `action:git push`, `path:~/x`, `instr:<hash>`, `quote:<hash>`. */
  key: string;
  /** The entry the change adds: a command head, a path, an instruction to enforce, or a rule line. */
  text: string;
  /** Project-relative files a scoped rule loads for. */
  paths?: string[];
  /** The words the fix is built from, and the file they were loaded from when not said in chat. */
  source: { quote: string; from?: string };
  sessionId: string;
  turns: number[];
  /** The project key of the session it came from: where applying it would have helped. */
  project: string;
  /** False: printed only (a Stop hook, until bounded; see .claude/rules/fixes.md). */
  applicable: boolean;
};

export type FindingContext = {
  /** The finding's session, in seq order. */
  events: Event[];
  project: string;
  /** The session's working directory, redacted the way event paths are. */
  cwd?: string;
  /** Who wrote the finding's quote (`quoteAuthor` in src/gather.ts). */
  author?: 'developer' | 'agent';
  /** Paths the harness writes for itself (plans, memory, temp): never a guard's target. */
  ownedByHarness: (path: string) => boolean;
};

/** A rule line longer than this is a pasted paragraph, not a standing instruction. */
const RULE_MAX = 240;
/** More files than this and a scoped rule names their directory instead. */
const SCOPED_FILES_MAX = 5;
const WORD = /^[a-z][\w.-]*$/;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const hash = (s: string): string => createHash('sha256').update(s.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 8);

/**
 * The first two words of each simple command in a shell line (`git push`), heredoc bodies and env
 * assignments dropped. Only plain lowercase words survive, so nothing secret can.
 */
export function commandHeads(cmd: string): string[] {
  const body = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '');
  const out: string[] = [];
  for (const segment of body.split(/\n|;|&&|\|\||\|/)) {
    const words: string[] = [];
    const tokens = segment.trim().split(/\s+/).filter((t) => t !== '' && !/^\w+=/.test(t));
    for (let i = 0; i < tokens.length && words.length < 2; i++) {
      const t = tokens[i] as string;
      // `git -c k=v push`, `git -C dir push`: an option's value is not a word of the command.
      if (t === '-c' || t === '-C') {
        i++;
        continue;
      }
      if (t.startsWith('-')) continue;
      words.push(t);
    }
    const plain = words.findIndex((w) => !WORD.test(w));
    const head = plain === -1 ? words : words.slice(0, plain);
    if (head.length > 0) out.push(head.join(' '));
  }
  return out;
}

const NEGATION = new Set(['dont', 'never', 'not', 'no', 'stop', 'without', 'cant', 'wont']);

/**
 * The developer forbade this verb: it appears ("push", "pushed", "pushing") within three words after a
 * negation, or just before "without". A mention alone is not a prohibition.
 */
export function forbids(text: string, verb: string): boolean {
  if (verb.length < 3) return false;
  const w = text.toLowerCase().replace(/[’']/g, '').match(/[a-z]+/g) ?? [];
  return w.some(
    (t, i) =>
      (t === verb || (t.startsWith(verb) && t.length - verb.length <= 3)) &&
      (w.slice(Math.max(0, i - 3), i).some((n) => NEGATION.has(n)) || w[i + 1] === 'without'),
  );
}

/**
 * The turns a finding is about: from the developer prompt before its first cited turn (or where the
 * expectation was set, if later) through its last cited turn.
 */
function windowOf(f: JudgedFinding, events: Event[]): { lo: number; hi: number } {
  const first = Math.min(...f.turns);
  const hi = Math.max(...f.turns);
  const prompts = events.filter((e) => e.turnType === 'user_prompt' && !e.isSidechain && e.devCommand === undefined).map((e) => e.seq);
  const before = prompts.filter((s) => s < first);
  const lo = Math.max(before[before.length - 1] ?? -1, f.established?.turn ?? -1);
  return { lo, hi };
}

/**
 * The expectation the developer set in an earlier turn, as lookback verified it. The anchoring quote and
 * a developer-reference are not one: they are the reaction ("I had asked you…"), not the rule.
 */
function expectationOf(f: JudgedFinding): string | undefined {
  const e = f.established;
  return e !== undefined && e.source === 'turn' && e.quote.trim() !== '' ? e.quote.trim() : undefined;
}

/** Everything the developer said about it: the expectation, a reference to it, and their quote when it is theirs. */
function developerWords(f: JudgedFinding, author: FindingContext['author']): string[] {
  const out = [expectationOf(f), f.established?.source === 'developer-reference' ? f.established.quote.trim() : undefined];
  if (author === 'developer') out.push(f.quote?.trim());
  return out.filter((w): w is string => w !== undefined && w !== '');
}

/** Paths written in the window: Edit/Write targets and the files the harness recorded as changed. */
function writtenIn(events: Event[], lo: number, hi: number): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.seq <= lo || e.seq > hi) continue;
    if (e.turnType === 'tool_use' && e.toolName !== undefined && WRITE_TOOLS.has(e.toolName) && e.filePath !== undefined) out.add(e.filePath);
    for (const p of e.changedFiles ?? []) out.add(p);
  }
  return [...out];
}

/** Relative to the project, or undefined when outside it. A relative path is already relative. */
function inside(path: string, cwd: string | undefined): string | undefined {
  if (!path.startsWith('/') && !path.startsWith('~')) return path;
  if (cwd === undefined) return undefined;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : undefined;
}

/** The files themselves, up to SCOPED_FILES_MAX; more than that is not a scope. */
function scopeOf(paths: string[]): string[] | undefined {
  return paths.length === 0 || paths.length > SCOPED_FILES_MAX ? undefined : [...paths].sort();
}

/** One finding's fix: the strongest rung its evidence supports, or undefined when it supports none. */
export function fixForFinding(f: JudgedFinding, ctx: FindingContext): FindingFix | undefined {
  if (f.turns.length === 0) return undefined;
  const { lo, hi } = windowOf(f, ctx.events);
  const said = developerWords(f, ctx.author);
  const words = expectationOf(f);
  const base = { dimension: f.dimension, sessionId: f.sessionId, turns: f.turns, project: ctx.project };
  const make = (kind: FixKind, target: ApplyTarget, key: string, text: string, source: FindingFix['source'], extra: Partial<FindingFix> = {}): FindingFix => ({
    fixId: fixIdOf(target, f.dimension, key),
    kind,
    target,
    key,
    text,
    source,
    applicable: kind !== 'hook',
    ...base,
    ...extra,
  });

  // 1. A command the developer forbade, run in the window: the harness can ask before it runs.
  for (const e of ctx.events) {
    if (e.seq <= lo || e.seq > hi || e.turnType !== 'tool_use' || e.toolName !== 'Bash' || e.command === undefined) continue;
    for (const head of commandHeads(e.command)) {
      const quote = said.find((w) => forbids(w, head.split(' ').at(-1) as string));
      if (quote !== undefined) return make('permission', 'project-permissions', `action:${head}`, head, { quote });
    }
  }

  // 3. A write outside the project, on a finding about doing what was not asked.
  if (f.dimension === 'constraint_violation' || f.dimension === 'overreach') {
    const outside = writtenIn(ctx.events, lo, hi).filter(
      (p) => (p.startsWith('/') || p.startsWith('~')) && inside(p, ctx.cwd) === undefined && !ctx.ownedByHarness(p) && /^~?\/[\w./-]+$/.test(p),
    );
    const path = outside.sort()[0];
    if (path !== undefined && ctx.cwd !== undefined) {
      return make('guard', 'project-hooks', `path:${path}`, path, { quote: said[0] ?? f.quote ?? '' });
    }
  }

  // 6. Already a loaded instruction, and broken anyway: another line would repeat what failed.
  const e = f.established;
  if (e !== undefined && e.source === 'instruction' && e.quote.trim() !== '') {
    return make('check', 'project-check', `instr:${hash(e.quote)}`, e.quote.trim(), { quote: e.quote.trim(), ...(e.from !== undefined ? { from: e.from } : {}) });
  }

  // 7. A claim of success over a failure nothing later fixed: only running the check settles it.
  if (f.dimension === 'inaccurate_self_report') {
    const open = openFailuresBefore(ctx.events, hi + 1).filter((o) => o.turn > lo);
    const last = open[open.length - 1];
    if (last !== undefined) return make('hook', 'project-hooks', `open-failure:${f.dimension}`, last.what, { quote: f.quote ?? '' });
  }

  if (words === undefined || words.length > RULE_MAX) return undefined;
  const key = `quote:${hash(words)}`;

  // 5. The expectation, loaded only when the files written in spite of it are touched.
  const scope = scopeOf(writtenIn(ctx.events, lo, Math.min(...f.turns)).map((p) => inside(p, ctx.cwd)).filter((p): p is string => p !== undefined));
  if (scope !== undefined) return make('scoped-rule', 'scoped-instructions', key, ruleLine(words), { quote: words }, { paths: scope });

  return make('rule', 'project-instructions', key, ruleLine(words), { quote: words });
}

/** The change a finding's fix makes, or undefined when it may only be printed. */
export function findingPlan(x: FindingFix): ApplyPlan | undefined {
  if (!x.applicable) return undefined;
  return {
    fixId: x.fixId,
    dimension: x.dimension,
    target: x.target,
    text: x.text,
    key: x.key,
    ...(x.paths !== undefined ? { paths: x.paths } : {}),
    ...(x.source.from !== undefined ? { from: x.source.from } : {}),
  };
}

/** Every rule line a judged finding can produce, for spotting one loaded in a later session. */
export function findingRules(judged: JudgedFinding[]): string[] {
  return [...new Set(judged.map(expectationOf).filter((w): w is string => w !== undefined && w.length <= RULE_MAX).map(ruleLine))];
}

/** A standing rule in the developer's own words. */
function ruleLine(words: string): string {
  return `- Standing instruction from the developer: "${words.replace(/\s+/g, ' ').trim()}"`;
}

/**
 * The developer asked a question and got an edit: the prompt before the finding ends in `?` and a write
 * follows before the next prompt. Only a misread or unrequested work can be this.
 */
export function questionThenEdit(f: JudgedFinding, events: Event[]): boolean {
  if ((f.dimension !== 'misread_intent' && f.dimension !== 'overreach') || f.turns.length === 0) return false;
  const first = Math.min(...f.turns);
  const prompts = events.filter((e) => e.turnType === 'user_prompt' && !e.isSidechain && e.devCommand === undefined);
  const asked = prompts.filter((e) => e.seq <= first).at(-1);
  if (asked === undefined || !(asked.textSummary ?? '').trim().endsWith('?')) return false;
  const next = prompts.find((e) => e.seq > asked.seq)?.seq ?? Number.POSITIVE_INFINITY;
  return writtenIn(events, asked.seq, next - 1).length > 0;
}

/** What each kind of fix does, in words, the same on every surface. */
export const KIND_WORDS: Record<FixKind, string> = {
  permission: 'Claude Code asks you before this command runs, in every mode:',
  guard: 'Claude Code refuses an edit to this path and tells the agent why:',
  check: 'A test that fails when this rule is broken:',
  'scoped-rule': 'A rule the agent reads when it opens these files:',
  rule: 'A rule the agent reads in every session of this project:',
  hook: 'A check that runs each time the agent finishes a turn:',
  agent: 'A helper that answers questions and cannot edit:',
};

/** A fix shared by findings in more than one session: the dimension-level fix. */
export type SharedFix = { fix: FindingFix; findings: number; sessions: number; projects: string[] };

/** Fixes with the same target and key across ≥2 sessions, most sessions first. A `quote:` key never groups. */
export function sharedFixes(fixes: FindingFix[]): SharedFix[] {
  const by = new Map<string, FindingFix[]>();
  for (const x of fixes) {
    if (x.key.startsWith('quote:')) continue;
    const k = `${x.target}:${x.key}`;
    by.set(k, [...(by.get(k) ?? []), x]);
  }
  return [...by.values()]
    .map((xs) => ({ fix: xs[0] as FindingFix, findings: xs.length, sessions: new Set(xs.map((x) => x.sessionId)).size, projects: [...new Set(xs.map((x) => x.project))] }))
    .filter((s) => s.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions || b.findings - a.findings || a.fix.key.localeCompare(b.fix.key));
}

/** A read-only subagent, when questions answered with edits recur in ≥2 sessions. `allowed-tools` would not restrict: docs/artifacts.md. */
export function questionCommand(findings: { finding: JudgedFinding; project: string }[]): SharedFix | undefined {
  const sessions = new Set(findings.map((x) => x.finding.sessionId));
  const first = findings[0];
  if (sessions.size < 2 || first === undefined) return undefined;
  const key = 'theme:question-edit';
  const fix: FindingFix = {
    fixId: fixIdOf('project-agent', first.finding.dimension, key),
    dimension: first.finding.dimension,
    kind: 'agent',
    target: 'project-agent',
    key,
    text: 'ask',
    source: { quote: first.finding.quote ?? '' },
    sessionId: first.finding.sessionId,
    turns: first.finding.turns,
    project: first.project,
    applicable: true,
  };
  return { fix, findings: findings.length, sessions: sessions.size, projects: [...new Set(findings.map((x) => x.project))] };
}

/** One session as the ladder reads it, from the caller's own parse (the transcript, read in place). */
export type SessionForFix = Omit<FindingContext, 'author'> & { authorOf: (quote: string) => FindingContext['author'] };

export type FindingFixes = {
  /** Each finding's own fix, by finding id (or `session:turns` before it is stored). */
  byFinding: Map<string, FindingFix>;
  /** Fixes shared across ≥2 sessions, the read-only subagent included: the dimension-level fixes. */
  shared: SharedFix[];
};

export const findingKey = (f: JudgedFinding): string => f.id ?? `${f.sessionId}:${f.turns.join(',')}`;

/** Every finding's fix and the shared ones. A session that cannot be read gives its findings none. */
export function fixesFor(judged: JudgedFinding[], read: (sessionId: string) => SessionForFix | undefined): FindingFixes {
  const sessions = new Map<string, SessionForFix | undefined>();
  const byFinding = new Map<string, FindingFix>();
  const asked: { finding: JudgedFinding; project: string }[] = [];
  for (const f of judged) {
    if (!sessions.has(f.sessionId)) sessions.set(f.sessionId, read(f.sessionId));
    const s = sessions.get(f.sessionId);
    if (s === undefined) continue;
    const author = f.quote === undefined ? undefined : s.authorOf(f.quote);
    const x = fixForFinding(f, { events: s.events, project: s.project, ownedByHarness: s.ownedByHarness, ...(s.cwd !== undefined ? { cwd: s.cwd } : {}), ...(author !== undefined ? { author } : {}) });
    if (x !== undefined) byFinding.set(findingKey(f), x);
    if (questionThenEdit(f, s.events)) asked.push({ finding: f, project: s.project });
  }
  return { byFinding, shared: sharedFrom([...byFinding.values()], asked) };
}

/** The shared fixes from every finding's fix and the questions answered with edits, most sessions first. */
export function sharedFrom(fixes: FindingFix[], asked: { finding: JudgedFinding; project: string }[]): SharedFix[] {
  const agent = questionCommand(asked);
  return [...sharedFixes(fixes), ...(agent !== undefined ? [agent] : [])].sort((a, b) => b.sessions - a.sessions || b.findings - a.findings);
}
