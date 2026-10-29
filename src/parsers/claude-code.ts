/**
 * Claude Code transcript parser. Sequencing uses file order, not the parentUuid path; noise records
 * stay in the tree; rewinds are found structurally. Evidence for each: docs/log-formats.md.
 * The record envelope is not published, so `RawRecord` is ours; the inner `message` uses SDK types.
 */

import type {
  Message,
  MessageParam,
  TextBlock,
  ThinkingBlock,
  ToolResultBlockParam,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';
import { createHash } from 'node:crypto';
import { redact } from '../redact.ts';
import { outputDigest, isPlausibleTimestamp } from '../normalise.ts';
import type { Event, TurnType } from '../types.ts';

/** A `user` record whose string content starts with one of these is a slash-command echo, not a human. */
const META_CONTENT =
  /^\s*<(local-command-(caveat|stdout|stderr)|command-name|command-message|command-args|system-reminder)\b/;

/** `/name args` from a slash-command echo; undefined for any other text. */
export function slashCommand(text: string): string | undefined {
  const name = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (name === undefined) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return `${name.startsWith('/') ? name : `/${name}`}${args === '' ? '' : ` ${args}`}`;
}

/** Record types that carry no analysable signal. Traversed, never emitted. */
const NOISE_TYPES = new Set([
  'attachment', // mostly hook_success
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'ai-title',
  'agent-name',
  // Seen only in the public corpus:
  'progress', // hook progress ticks
  'frame-link', // artifact frame reference
]);

export type ParseOutput = {
  events: Event[];
  /** Unknown record types, counted. A format change should degrade coverage, not crash. */
  unknown: Record<string, number>;
  /** Lines that were not valid JSON. */
  malformed: number;
  /** Records skipped as noise, counted by type. */
  skipped: Record<string, number>;
  /** Records on a branch the user abandoned — rewound, or resubmitted. */
  abandoned: number;
};

type RawRecord = {
  type?: string;
  /** Present instead of `type` in some exports. */
  role?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  /** Set on the post-compaction summary written as a `user` record; not a prompt. */
  isCompactSummary?: boolean;
  cwd?: string;
  /** An API message: `Message` on assistant records, `MessageParam` on user records. Partial across versions. */
  message?: Partial<Message> & Partial<MessageParam>;
  subtype?: string;
  operation?: string;
  content?: unknown;
  snapshot?: { trackedFileBackups?: Record<string, unknown> };
  trackingPath?: string;
  [k: string]: unknown;
};

/**
 * A content block from untrusted JSON: flat, since `type` must be read first and Claude Code adds kinds
 * the SDK union lacks. Fields are SDK-typed so an upstream rename breaks the build.
 */
type AnyBlock = {
  type?: string;
  text?: TextBlock['text'];
  thinking?: ThinkingBlock['thinking'];
  name?: ToolUseBlock['name'];
  id?: ToolUseBlock['id'];
  input?: ToolUseBlock['input'];
  tool_use_id?: ToolResultBlockParam['tool_use_id'];
  is_error?: ToolResultBlockParam['is_error'];
  content?: ToolResultBlockParam['content'];
};

/**
 * Stable digest of a tool call's arguments: keys sorted, redacted before hashing so the hash is no
 * oracle for a secret. `undefined` for no arguments, so "none" differs from "unreadable".
 */
function argDigest(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'object' && Object.keys(input as object).length === 0) return undefined;
  let canonical: string;
  try {
    canonical = JSON.stringify(input, Object.keys(input as object).sort());
  } catch {
    return undefined;
  }
  return createHash('sha256').update(redact(canonical).text).digest('hex').slice(0, 16);
}

/** Every path that reaches an `Event` goes through here, so redaction cannot be forgotten. */
function cleanPath(p: string | undefined): string | undefined {
  return p === undefined ? undefined : redact(p).text;
}

/** Prompt cap: larger than the 200 default because the judge reads prompts for meaning. */
const PROMPT_SUMMARY_MAX = 1200;

/** Single-line, capped, redacted at construction. Redact before truncating: half a key still leaks. */
function summarise(s: unknown, max = 200): string | undefined {
  if (typeof s !== 'string') return undefined;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  const clean = redact(flat).text;
  if (clean.length <= max) return clean;

  // Space before `…` so `/home/…` is not masked as a username. Head-only: this is the display path.
  return redactToFixedPoint(`${clean.slice(0, max)} …`);
}

/**
 * Redact until the text stops changing: a cut can leave `KEY= …`, which the next pass would consume.
 * Every summary is a fixed point of `redact`, which scripts/verify-corpus.ts relies on to detect leaks.
 */
function redactToFixedPoint(s: string, limit = 4): string {
  let cur = s;
  for (let i = 0; i < limit; i++) {
    const next = redact(cur).text;
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Judge mode: keep the full redacted text beside the capped summary. Module state because `sum` is
 * called right before `push` assigns the seq; `withFullText` owns the lifetime. Never stored.
 */
let keepFullText = false;
let pendingFullText: string | undefined;

/** A project instruction the harness loaded (CLAUDE.md, a rule, memory), redacted, and the seq it applies from. */
export type Instruction = { fromSeq: number; source: string; text: string };

export function withFullText<T>(fn: () => T): { result: T; fullText: Map<number, string>; instructions: Instruction[] } {
  keepFullText = true;
  capturedFullText = new Map();
  capturedInstructions = [];
  try {
    const result = fn();
    return { result, fullText: capturedFullText, instructions: capturedInstructions };
  } finally {
    keepFullText = false;
    pendingFullText = undefined;
    capturedFullText = new Map();
    capturedInstructions = [];
  }
}

let capturedInstructions: Instruction[] = [];

/** `CLAUDE.md`, `rules/hooks.md`, `memory`: what a finding can cite as its source. */
function instructionSource(path: string, kind: unknown): string {
  if (kind === 'AutoMem') return 'memory';
  const rule = /\/\.claude\/rules\/(.+)$/.exec(path);
  if (rule !== null) return `rules/${rule[1] as string}`;
  return path.split('/').at(-1) ?? path;
}

/**
 * Keep the instructions an `attachment` record carries, in judge mode only: CLAUDE.md, rules and
 * memory as the harness loaded them. Redacted here; never stored. See `src/judge/lookback.ts`.
 */
function captureInstructions(a: unknown, fromSeq: number): void {
  if (!keepFullText || a === null || typeof a !== 'object') return;
  const at = a as { type?: unknown; files?: unknown; content?: unknown };
  const add = (path: unknown, kind: unknown, content: unknown): void => {
    if (typeof path !== 'string' || typeof content !== 'string' || content.trim() === '') return;
    capturedInstructions.push({ fromSeq, source: instructionSource(path, kind), text: redactToFixedPoint(redact(content).text) });
  };
  if (at.type === 'instructions' && Array.isArray(at.files)) {
    for (const f of at.files as { path?: unknown; type?: unknown; content?: unknown }[]) add(f.path, f.type, f.content);
  } else if (at.type === 'nested_memory' && at.content !== null && typeof at.content === 'object') {
    const c = at.content as { path?: unknown; type?: unknown; content?: unknown };
    add(c.path, c.type, c.content);
  }
}

let capturedFullText = new Map<number, string>();

/** The optional `textSummary` in one step (a ternary would defeat `exactOptionalPropertyTypes` narrowing). */
function sum(s: unknown, max?: number): { textSummary: string } | Record<string, never> {
  const t = max === undefined ? summarise(s) : summarise(s, max);
  if (keepFullText && typeof s === 'string') {
    const flat = s.replace(/\s+/g, ' ').trim();
    // Redacted exactly as the summary is.
    if (flat !== '') pendingFullText = redactToFixedPoint(redact(flat).text);
  }
  return t === undefined ? {} : { textSummary: t };
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as AnyBlock).text) : ''))
      .filter((t) => t !== '');
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * `Exit code N` appears only on failure, so a missing code means "succeeded, or not a shell command",
 * never "unknown". See docs/log-formats.md.
 */
function extractExitCode(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /^Exit code (\d+)/m.exec(text);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

/**
 * Who rejected a failed call, read from the harness's envelope, never the prose inside it, plus two inner
 * messages that name another rejecter (a sibling cascade; a Read deny rule). Unfamiliar framing is `other`.
 */
export function failureKindOf(text: string | undefined): NonNullable<Event['failureKind']> {
  if (text === undefined) return 'other';
  const t = text.trimStart();
  if (t.startsWith('<tool_use_error>')) {
    const inner = t.slice('<tool_use_error>'.length).trimStart();
    if (inner.startsWith('Sibling tool call errored')) return 'cascade';
    if (inner.startsWith('File is covered by a Read deny rule')) return 'permission';
    return 'tool';
  }
  // The user's own hook, by name.
  if (/^(?:Pre|Post)ToolUse:\w+ hook error:/.test(t)) return 'hook';
  if (t.startsWith("The user doesn't want to proceed")) return 'denied';
  if (t.startsWith('Claude requested permissions')) return 'permission';
  return 'other';
}

/**
 * Does this command pipe into `head` or `tail`? Narrow on purpose: it only lowers confidence.
 * Not negative evidence: `sed -n '1,30p'` truncates too and is not matched.
 */
export function truncatesOutput(command: string | undefined): boolean {
  if (command === undefined) return false;
  return /\|\s*(?:head|tail)\b/.test(command);
}

function tokensOf(usage: Partial<Usage> | undefined): Event['tokens'] | undefined {
  if (!usage) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheCreation === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreation } : {}),
  };
}

/**
 * The identifying argument of a tool call, kept verbatim but redacted (home paths become `~`):
 * these fields bypass `summarise()`.
 */
function toolTarget(name: string | undefined, input: unknown): {
  filePath?: string;
  command?: string;
  pattern?: string;
} {
  if (!input || typeof input !== 'object') return {};
  const rec = input as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof rec[k] === 'string' ? (rec[k] as string) : undefined;
  const out: { filePath?: string; command?: string; pattern?: string } = {};
  const fp = cleanPath(str('file_path') ?? str('path') ?? str('notebook_path'));
  const cmd = cleanPath(str('command'));
  const pat = cleanPath(str('pattern') ?? str('query'));
  if (fp !== undefined) out.filePath = fp;
  if (cmd !== undefined) out.command = cmd;
  if (pat !== undefined) out.pattern = pat;
  void name;
  return out;
}

type TreeNode = {
  uuid: string;
  parentUuid: string | null;
  type: string;
  isHumanPrompt: boolean;
  isSidechain: boolean;
};

/**
 * Which subagent each sidechain record belongs to. `isSidechain` says only that, not whose, so the
 * topmost sidechain ancestor's uuid is used as the id; otherwise parallel subagents merge into one thread.
 */
function attributeSidechains(nodes: TreeNode[]): Map<string, string> {
  const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
  const out = new Map<string, string>();

  for (const n of nodes) {
    if (!n.isSidechain) continue;
    let top = n.uuid;
    let cur: string | null = n.parentUuid;
    // Cycle guard: a corrupt file must not hang the parser.
    const seen = new Set<string>([n.uuid]);
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const p = byUuid.get(cur);
      if (p === undefined || !p.isSidechain) break;
      top = p.uuid;
      cur = p.parentUuid;
    }
    out.set(n.uuid, top);
  }

  return out;
}

/**
 * Which records sit on a branch the user walked away from: an off-spine subtree that contains a human
 * prompt (parallel tool-call siblings never do). Sidechains are excluded. See docs/log-formats.md.
 */
function markAbandoned(nodes: TreeNode[]): Set<string> {
  if (nodes.length === 0) return new Set();
  const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const k = n.parentUuid ?? '\u0000root';
    const list = kids.get(k);
    if (list) list.push(n);
    else kids.set(k, [n]);
  }

  // Live spine: up from the final record.
  const spine = new Set<string>();
  let cur: string | undefined = nodes[nodes.length - 1]?.uuid;
  while (cur !== undefined && byUuid.has(cur)) {
    spine.add(cur);
    const p = byUuid.get(cur)?.parentUuid;
    if (p === null || p === undefined || !byUuid.has(p)) break;
    cur = p;
  }

  const subtreeOf = (root: string): string[] => {
    const out: string[] = [];
    const stack = [root];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const n = stack.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      for (const c of kids.get(n) ?? []) stack.push(c.uuid);
    }
    return out;
  };

  const dead = new Set<string>();
  for (const node of spine) {
    for (const child of kids.get(node) ?? []) {
      if (spine.has(child.uuid)) continue; // the branch that was continued
      if (child.isSidechain) continue; // a subagent's work, not an abandoned branch
      const sub = subtreeOf(child.uuid);
      if (sub.some((u) => byUuid.get(u)?.isHumanPrompt === true)) {
        for (const u of sub) dead.add(u);
      }
    }
  }
  return dead;
}

export function parseTranscript(lines: Iterable<string>, fallbackSessionId = ''): ParseOutput {
  const events: Event[] = [];
  const unknown: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  let malformed = 0;
  let seq = 0;

  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };

  // tool_use_id → tool name, so a tool_result can name the tool it belongs to.
  const toolById = new Map<string, string>();

  // For the abandonment pass, which needs the whole file.
  const nodes: TreeNode[] = [];
  /** The developer's slash commands by echo uuid: their instructions are the `isMeta` record parented on it. */
  const commandByUuid = new Map<string, string>();
  /** Per-path file version, so a *rising* version marks a real change. */
  const fileVersions = new Map<string, number>();
  /** event index → the uuid it came from, so the flag can be applied after. */
  const eventUuid: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let r: RawRecord;
    try {
      r = JSON.parse(line) as RawRecord;
    } catch {
      malformed++;
      continue;
    }

    // Some exports carry only `role`; it supplies the type.
    const type = r.type ?? (r.role === 'user' || r.role === 'assistant' ? r.role : '(missing)');
    if (NOISE_TYPES.has(type)) {
      bump(skipped, type);
      if (type === 'attachment') captureInstructions((r as { attachment?: unknown }).attachment, seq);
      // Still part of the tree, or the spine walk breaks.
      if (r.uuid !== undefined) {
        nodes.push({
          uuid: r.uuid,
          parentUuid: r.parentUuid ?? null,
          type,
          isHumanPrompt: false,
          isSidechain: r.isSidechain === true,
        });
      }
      continue;
    }

    const sessionId = r.sessionId ?? fallbackSessionId;
    const base = {
      sessionId,
      harness: 'claude-code' as const,
      uuid: r.uuid ?? `synthetic-${seq}`,
      parentUuid: r.parentUuid ?? null,
      isSidechain: r.isSidechain === true,
      // Omitted, not '', when absent (e.g. `file-history-snapshot`).
      ...(isPlausibleTimestamp(r.timestamp) ? { ts: r.timestamp } : {}),
    };

    const push = (turnType: TurnType, extra: Partial<Event> = {}): void => {
      eventUuid.push(base.uuid);
      // Claim whatever `sum` left, under the seq this event is getting.
      if (pendingFullText !== undefined) {
        capturedFullText.set(seq, pendingFullText);
        pendingFullText = undefined;
      }
      events.push({ ...base, seq: seq++, turnType, ...extra });
    };

    // Every record with a uuid joins the tree.
    if (r.uuid !== undefined) {
      const c = r.message?.content;
      nodes.push({
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        type,
        isHumanPrompt:
          type === 'user' && typeof c === 'string' && !META_CONTENT.test(c),
        isSidechain: r.isSidechain === true,
      });
    }

    switch (type) {
      case 'user': {
        const content = r.message?.content;
        // A compaction summary is not a prompt; marked `compaction` alongside `compact_boundary`,
        // since the corpus carries only one of the two shapes. Consumers take the first.
        if (r.isCompactSummary === true) {
          push('system', { systemKind: 'compaction', textSummary: 'compaction:summary' });
          break;
        }

        // `isMeta`: a slash command's own stdout (ours included), not the developer speaking.
        if (r.isMeta === true) {
          const text = toolResultText(content) ?? '';
          const of = r.parentUuid == null ? undefined : commandByUuid.get(r.parentUuid);
          // A skill the agent loaded hangs off its tool result, so it never matches here.
          const isInstructions = of !== undefined && text.trim() !== '' && !META_CONTENT.test(text);
          push('local_command', { ...sum(text), ...(isInstructions ? { devCommand: { name: of, part: 'instructions' as const } } : {}) });
          break;
        }
        const cmd = typeof content === 'string' ? slashCommand(content) : undefined;
        if (cmd !== undefined) {
          const name = cmd.split(' ')[0] as string;
          if (r.uuid !== undefined) commandByUuid.set(r.uuid, name);
          push('local_command', { ...sum(cmd), devCommand: { name, part: 'invocation' } });
          break;
        }
        if (typeof content === 'string') {
          // Prompts get the larger cap; other text keeps 200 (compared by digest, not read).
          const isPrompt = !META_CONTENT.test(content);
          push(isPrompt ? 'user_prompt' : 'local_command', {
            ...(isPrompt ? sum(content, PROMPT_SUMMARY_MAX) : sum(content)),
          });
        } else if (Array.isArray(content)) {
          // tool_result blocks are the harness replying, not the human.
          for (const b of content as AnyBlock[]) {
            if (b?.type === 'tool_result') {
              const text = toolResultText(b.content);
              const exitCode = extractExitCode(text);
              const toolName = b.tool_use_id ? toolById.get(b.tool_use_id) : undefined;
              // Digest the full output, redacted first so it cannot confirm a secret.
              const outHash = text === undefined ? undefined : outputDigest(redact(text).text);
              push('tool_result', {
                ...(toolName !== undefined ? { toolName } : {}),
                ...(b.tool_use_id !== undefined ? { toolCallId: b.tool_use_id } : {}),
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(outHash !== undefined ? { outHash } : {}),
                ...(text !== undefined ? { outBytes: Buffer.byteLength(text) } : {}),
                ...(b.is_error === true || (exitCode !== undefined && exitCode !== 0)
                  ? { isError: true, failureKind: failureKindOf(text) }
                  : {}),
                ...sum(text),
              });
            } else if (b?.type === 'text') {
              // A reminder or command echo inside array content is the harness, not the person.
              const isPrompt = typeof b.text !== 'string' || !META_CONTENT.test(b.text);
              push(isPrompt ? 'user_prompt' : 'local_command', { ...sum(b.text) });
            }
          }
        }
        break;
      }

      case 'assistant': {
        const content = r.message?.content;
        const tokens = tokensOf(r.message?.usage);
        // One response spans several records repeating the same `message.id` and `usage`;
        // count usage once per response (`responseId`), not per record.
        const responseId = typeof r.message?.id === 'string' ? r.message.id : undefined;
        if (!Array.isArray(content)) break;
        for (const b of content as AnyBlock[]) {
          switch (b?.type) {
            case 'tool_use':
            case 'server_tool_use': {
              if (b.id !== undefined && b.name !== undefined) toolById.set(b.id, b.name);
              const target = toolTarget(b.name, b.input);
              push('tool_use', {
                ...(b.name !== undefined ? { toolName: b.name } : {}),
                ...(b.id !== undefined ? { toolCallId: b.id } : {}),
                ...target,
                ...(argDigest(b.input) !== undefined
                  ? { argHash: argDigest(b.input) as string }
                  : {}),
                // Size of the call's arguments: the dominant cost of a refused edit.
                ...(b.input !== undefined
                  ? { argBytes: Buffer.byteLength(JSON.stringify(b.input)) }
                  : {}),
                // So a detector never reads the command to learn this.
                ...(truncatesOutput(target.command) ? { truncatesOwnOutput: true } : {}),
                ...(tokens !== undefined ? { tokens } : {}),
          ...(responseId !== undefined ? { responseId } : {}),
              });
              break;
            }
            case 'advisor_tool_result': {
              // The advisor's result is inline in the assistant record.
              push('tool_result', {
                toolName: 'advisor',
                ...sum(b.content),
              });
              break;
            }
            case 'text':
            case 'thinking': {
              const t = summarise(b.text ?? b.thinking);
              push('assistant_msg', {
                ...(t !== undefined ? { textSummary: t } : {}),
                ...(tokens !== undefined ? { tokens } : {}),
          ...(responseId !== undefined ? { responseId } : {}),
              });
              break;
            }
            default:
              // Unknown block types: counted, not dropped silently.
              bump(unknown, `assistant.content.${b?.type ?? 'unknown'}`);
          }
        }
        break;
      }

      case 'system': {
        // Compaction as local transcripts record it; `compactMetadata` has the harness's exact token counts.
        if (r.subtype === 'compact_boundary') {
          const meta = (r as { compactMetadata?: Record<string, unknown> }).compactMetadata ?? {};
          const n = (k: string): number | undefined =>
            typeof meta[k] === 'number' ? (meta[k] as number) : undefined;
          const pre = n('preTokens');
          const post = n('postTokens');
          push('system', {
            systemKind: 'compaction',
            textSummary: `compaction:${String(meta['trigger'] ?? 'unknown')}`,
            ...(pre !== undefined && post !== undefined
              ? { compaction: { preTokens: pre, postTokens: post } }
              : {}),
          });
          break;
        }

        push('system', {
          systemKind: 'other',
          ...(r.subtype !== undefined ? { textSummary: `system:${r.subtype}` } : {}),
        });
        break;
      }

      case 'queue-operation': {
        // enqueue / remove / dequeue. Not by itself an interrupt:
        // CLAUDE.md "A mechanism is not a behaviour".
        push('queue_operation', {
          ...(r.operation !== undefined ? { queueOpSubtype: r.operation } : {}),
          ...sum(r.content),
        });
        break;
      }

      case 'file-history-snapshot': {
        // A rising `version` is tool-agnostic proof a file changed.
        const backups = (r.snapshot?.trackedFileBackups ?? {}) as Record<
          string,
          { version?: unknown } | undefined
        >;
        const changed: string[] = [];
        for (const [path, meta] of Object.entries(backups)) {
          const version = typeof meta?.version === 'number' ? meta.version : undefined;
          if (version === undefined) continue;
          const prior = fileVersions.get(path);
          if (prior !== undefined && version <= prior) continue;
          fileVersions.set(path, version);
          // A first sighting is the baseline; only an increase is a change.
          if (prior !== undefined) {
            const clean = cleanPath(path);
            if (clean !== undefined) changed.push(clean);
          }
        }
        const tracked = Object.keys(backups);
        push('system', {
          systemKind: 'file-history',
          textSummary: `file-history-snapshot:${tracked.length} tracked`,
          ...(cleanPath(tracked[0]) !== undefined ? { filePath: cleanPath(tracked[0]) as string } : {}),
          ...(changed.length > 0 ? { changedFiles: changed } : {}),
        });
        break;
      }

      // Types seen only in the public corpus.

      case 'summary': {
        // What compaction leaves behind; `leafUuid` anchors it to the turn it replaced.
        const sm = r as { summary?: unknown; leafUuid?: unknown };
        push('system', {
          systemKind: 'compaction',
          ...sum(sm.summary),
          ...(typeof sm.leafUuid === 'string' ? { toolCallId: sm.leafUuid } : {}),
        });
        break;
      }

      case 'cost-state': {
        // Session totals, including lines added/removed.
        const cs = r as {
          totalLinesAdded?: unknown;
          totalLinesRemoved?: unknown;
          totalCostUSD?: unknown;
        };
        const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
        const cost = num(cs.totalCostUSD);
        push('system', {
          systemKind: 'cost-state',
          textSummary:
            `cost-state: +${num(cs.totalLinesAdded) ?? 0}/-${num(cs.totalLinesRemoved) ?? 0} lines` +
            (cost !== undefined ? `, $${cost.toFixed(4)}` : ''),
        });
        break;
      }

      case 'pr-link': {
        // A pull request was opened.
        const pr = r as { prNumber?: unknown; prRepository?: unknown };
        push('system', {
          systemKind: 'pr-link',
          textSummary: `pr-link: ${String(pr.prRepository ?? '?')}#${String(pr.prNumber ?? '?')}`,
        });
        break;
      }

      case 'file-history-delta': {
        push('system', {
          systemKind: 'file-history',
          textSummary: 'file-history-delta',
          ...(typeof r.trackingPath === 'string'
            ? { filePath: cleanPath(r.trackingPath) as string }
            : {}),
        });
        break;
      }

      default:
        bump(unknown, type);
    }
  }

  const subagent = attributeSidechains(nodes);
  if (subagent.size > 0) {
    for (let i = 0; i < events.length; i++) {
      const u = eventUuid[i];
      const root = u === undefined ? undefined : subagent.get(u);
      if (root !== undefined) (events[i] as Event).sidechainId = root;
    }
  }

  const dead = markAbandoned(nodes);
  let abandoned = 0;
  if (dead.size > 0) {
    for (let i = 0; i < events.length; i++) {
      const u = eventUuid[i];
      if (u !== undefined && dead.has(u)) {
        (events[i] as Event).abandoned = true;
        abandoned++;
      }
    }
  }

  // Counts abandoned events, not records (noise records never become events).
  return { events, unknown, malformed, skipped, abandoned };
}

/** Convenience wrapper for a whole file's contents. */
export function parseTranscriptText(text: string, fallbackSessionId = ''): ParseOutput {
  return parseTranscript(text.split('\n'), fallbackSessionId);
}
