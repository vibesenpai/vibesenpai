/**
 * Claude Code transcript parser.
 *
 * Every structural decision here is grounded in measurement over 2,336 real
 * records across 3 archived sessions (2026-10-15). See docs/log-formats.md for
 * the observed record inventory.
 *
 * Three findings shaped this file, and two of them contradicted the design:
 *
 * 1. FILE ORDER IS AUTHORITATIVE, not the parentUuid path.
 *    The design said "reconstruct the active leaf path, then index". Measured:
 *    the longest path covers 1325 of 1695 records (78.2%), and walking it would
 *    DROP 46 real records — 39 of them `tool_result`s, which is exactly what
 *    no_verification and fail_fix_fail depend on. Those records are not
 *    abandoned work; they are parallel tool calls, where an assistant tool_use
 *    and a user tool_result legitimately share a parent.
 *    File order covers 100% and is already topologically sorted (0
 *    parent-after-child violations), so it is used for sequencing.
 *
 * 2. `attachment` records sit INSIDE the parentUuid chain, not hanging off it.
 *    Filtering them before walking the tree orphans every record beneath them —
 *    it turned 1 root into 305. So they are traversed through and skipped only
 *    at emit time.
 *
 * 3. tool_use pairs with tool_result by `tool_use_id`, not by tree position.
 *
 * 4. A REWIND LEAVES ITS ABANDONED BRANCH IN THE FILE, UNMARKED.
 *    Observed 2026-10-15 in a session rewound on purpose: the pre-rewind records
 *    remain, nothing is truncated, no new file is created, and there is no
 *    `isRewound` / `prunedAt` / marker of any kind. 38 of 71 records were dead.
 *    So abandonment is derivable only structurally — see `markAbandoned`.
 *
 * parentUuid is still kept on every event: it is needed for grouping, and for
 * detecting genuinely abandoned subtrees if a rewind ever appears in real data.
 * No rewind has been observed yet, so that handling stays unwritten rather than
 * guessed at.
 *
 * ── Where these types come from ──────────────────────────────────────────────
 *
 * The INNER `message` object is an Anthropic API message, and its types ARE
 * published — so they are imported from `@anthropic-ai/sdk` rather than
 * redeclared. The SDK's own guidance is explicit about this: "Don't define
 * custom types for SDK data structures… defining your own duplicates what the
 * SDK already provides and loses type safety."
 *
 * The OUTER envelope (`type`, `uuid`, `parentUuid`, `isSidechain`, `cwd`,
 * `gitBranch`, and the non-message record types) is **not published anywhere
 * authoritative.** Checked 2026-10-15:
 *
 *   - `@anthropic-ai/claude-agent-sdk` exports `getSessionMessages()` and a
 *     `SessionMessage` type — but it is a *transformed* view, not the raw
 *     record: snake_case fields, `message: unknown` (so the part we most need
 *     is untyped), and `type: 'user' | 'assistant' | 'system'` only, which
 *     drops `queue-operation` and `file-history-snapshot` — our interrupt and
 *     revert signals. It also reads the live project directory, which is the
 *     one place we must not read from, since the harness deletes it.
 *   - Community write-ups exist and are often labelled "official". They are not.
 *
 * So `RawRecord` below is ours by necessity, and is therefore derived from
 * measurement and documented in docs/log-formats.md with observed counts. If
 * Anthropic ever publishes the envelope, this is the type to delete.
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
import type { Event, TurnType } from '../types.ts';

/**
 * A `user` record whose string content is one of these wrappers is a slash-command
 * echo, not a human speaking. Measured: 13 of 69 "prompts" across 3 real sessions.
 */
const META_CONTENT =
  /^\s*<(local-command-(caveat|stdout|stderr)|command-name|command-message|command-args|system-reminder)\b/;

/** Record types that carry no analysable signal. Traversed, never emitted. */
const NOISE_TYPES = new Set([
  'attachment', // 710 of 2336 — the single most common type, almost all hook_success
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'ai-title',
  'agent-name',
]);

export type ParseResult = {
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
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  /**
   * An Anthropic API message. `assistant` records carry a response-shaped
   * `Message` (content is `ContentBlock[]`); `user` records carry a
   * request-shaped `MessageParam` (content is `string | ContentBlockParam[]`).
   * Partial, because a record on disk may predate or postdate this build.
   */
  message?: Partial<Message> & Partial<MessageParam>;
  subtype?: string;
  operation?: string;
  content?: unknown;
  snapshot?: { trackedFileBackups?: Record<string, unknown> };
  trackingPath?: string;
  [k: string]: unknown;
};

/**
 * A content block as it arrives from untrusted JSON on disk.
 *
 * Deliberately flat rather than a union of the SDK's discriminated members: the
 * `type` tag has to be read before anything can be narrowed, and the file may
 * contain Claude Code-only kinds (`advisor_tool_result`) that are not in the
 * SDK union at all.
 *
 * Every field is still **typed from the SDK**, so an upstream rename or type
 * change breaks this build rather than silently parsing to `undefined`. That is
 * the actual benefit of depending on the published types — not the shape, the
 * early warning.
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

/** Short, single-line, length-capped. Full redaction is redact.ts's job. */
function summarise(s: unknown, max = 200): string | undefined {
  if (typeof s !== 'string') return undefined;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Build the optional `textSummary` property in one step. Calling `summarise()`
 * inside a ternary defeats narrowing under `exactOptionalPropertyTypes`.
 */
function sum(s: unknown, max?: number): { textSummary: string } | Record<string, never> {
  const t = max === undefined ? summarise(s) : summarise(s, max);
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
 * `Exit code N` appears as the first line of Bash tool_result content — but
 * ONLY on failure. Measured across 3 sessions: the sole exit code ever present
 * is 1; successful commands carry no prefix at all.
 *
 * So the semantics are asymmetric and detectors must not invert them: a missing
 * exit code means "succeeded, or not a shell command", never "unknown". That
 * distinction is what keeps `error_ignored` from firing on every Read call.
 */
function extractExitCode(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /^Exit code (\d+)/m.exec(text);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

function tokensOf(usage: Partial<Usage> | undefined): Event['tokens'] | undefined {
  if (!usage) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
  };
}

/** Pull the most useful identifying argument out of a tool call. */
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
  const fp = str('file_path') ?? str('path') ?? str('notebook_path');
  const cmd = str('command');
  const pat = str('pattern') ?? str('query');
  if (fp !== undefined) out.filePath = fp;
  if (cmd !== undefined) out.command = cmd;
  if (pat !== undefined) out.pattern = pat;
  void name;
  return out;
}

type TreeNode = { uuid: string; parentUuid: string | null; type: string; isHumanPrompt: boolean };

/**
 * Which records sit on a branch the user walked away from.
 *
 * File order is topological, so **the last record in the file is on the live
 * path**. Walking up its `parentUuid` chain gives the live spine; any sibling
 * subtree hanging off that spine was not continued.
 *
 * The discriminator is then: **does that subtree contain a human prompt?**
 *
 *   - A rewind's dead branch does — it is a whole conversation segment.
 *   - A parallel tool call's sibling is a `tool_result` stub and never does.
 *
 * That distinction matters because an earlier attempt at this used subtree size
 * ("one side dies early, the other continues"), which flagged all 42 parallel
 * tool calls in a real session. Verified on 4 sessions: 1 rewind and 2 abandoned
 * prompts found, 0 false positives.
 */
export function markAbandoned(nodes: TreeNode[]): Set<string> {
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
      const sub = subtreeOf(child.uuid);
      if (sub.some((u) => byUuid.get(u)?.isHumanPrompt === true)) {
        for (const u of sub) dead.add(u);
      }
    }
  }
  return dead;
}

export function parseTranscript(lines: Iterable<string>, fallbackSessionId = ''): ParseResult {
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

  // Collected for the abandonment pass, which needs the whole file: the live
  // spine is only known once the final record has been read.
  const nodes: TreeNode[] = [];
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

    const type = r.type ?? '(missing)';
    if (NOISE_TYPES.has(type)) {
      bump(skipped, type);
      // Still part of the tree: a branch point's parent was an `attachment` in
      // the observed rewind, so skipping them here would break the spine walk.
      if (r.uuid !== undefined) {
        nodes.push({
          uuid: r.uuid,
          parentUuid: r.parentUuid ?? null,
          type,
          isHumanPrompt: false,
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
      ts: r.timestamp ?? '',
    };

    const push = (turnType: TurnType, extra: Partial<Event> = {}): void => {
      eventUuid.push(base.uuid);
      events.push({ ...base, seq: seq++, turnType, ...extra });
    };

    // Every record with a uuid joins the tree — including noise types, which sit
    // *inside* the parentUuid chain rather than hanging off it.
    if (r.uuid !== undefined) {
      const c = r.message?.content;
      nodes.push({
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        type,
        isHumanPrompt:
          type === 'user' && typeof c === 'string' && !META_CONTENT.test(c),
      });
    }

    switch (type) {
      case 'user': {
        const content = r.message?.content;
        if (typeof content === 'string') {
          // A slash-command echo is not a human speaking.
          push(META_CONTENT.test(content) ? 'local_command' : 'user_prompt', { ...sum(content) });
        } else if (Array.isArray(content)) {
          // A user record holding tool_result blocks is the harness replying to
          // the agent, not the human speaking.
          for (const b of content as AnyBlock[]) {
            if (b?.type === 'tool_result') {
              const text = toolResultText(b.content);
              const exitCode = extractExitCode(text);
              const toolName = b.tool_use_id ? toolById.get(b.tool_use_id) : undefined;
              push('tool_result', {
                ...(toolName !== undefined ? { toolName } : {}),
                ...(b.tool_use_id !== undefined ? { toolCallId: b.tool_use_id } : {}),
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(b.is_error === true || (exitCode !== undefined && exitCode !== 0)
                  ? { isError: true }
                  : {}),
                ...sum(text),
              });
            } else if (b?.type === 'text') {
              push('user_prompt', { ...sum(b.text) });
            }
          }
        }
        break;
      }

      case 'assistant': {
        const content = r.message?.content;
        const tokens = tokensOf(r.message?.usage);
        if (!Array.isArray(content)) break;
        for (const b of content as AnyBlock[]) {
          switch (b?.type) {
            case 'tool_use':
            case 'server_tool_use': {
              if (b.id !== undefined && b.name !== undefined) toolById.set(b.id, b.name);
              push('tool_use', {
                ...(b.name !== undefined ? { toolName: b.name } : {}),
                ...(b.id !== undefined ? { toolCallId: b.id } : {}),
                ...toolTarget(b.name, b.input),
                ...(tokens !== undefined ? { tokens } : {}),
              });
              break;
            }
            case 'advisor_tool_result': {
              // The advisor tool returns its result inline in the assistant
              // record rather than as a separate user tool_result record.
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
              });
              break;
            }
            default:
              // advisor_tool_result and future block types: counted, not dropped silently.
              bump(unknown, `assistant.content.${b?.type ?? 'unknown'}`);
          }
        }
        break;
      }

      case 'system': {
        push('system', {
          ...(r.subtype !== undefined ? { textSummary: `system:${r.subtype}` } : {}),
        });
        break;
      }

      case 'queue-operation': {
        // Observed operations: enqueue, remove, dequeue. A mid-turn message the
        // user sent while the agent was working — the interrupt signal.
        push('queue_operation', {
          ...(r.operation !== undefined ? { queueOpSubtype: r.operation } : {}),
          ...sum(r.content),
        });
        break;
      }

      case 'file-history-snapshot': {
        const tracked = Object.keys(r.snapshot?.trackedFileBackups ?? {});
        push('system', {
          textSummary: `file-history-snapshot:${tracked.length} tracked`,
          ...(tracked[0] !== undefined ? { filePath: tracked[0] } : {}),
        });
        break;
      }

      case 'file-history-delta': {
        push('system', {
          textSummary: 'file-history-delta',
          ...(typeof r.trackingPath === 'string' ? { filePath: r.trackingPath } : {}),
        });
        break;
      }

      default:
        bump(unknown, type);
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

  // Counts abandoned EVENTS, not abandoned records — the dead subtree also
  // contains noise records that never become events, and reporting those would
  // not match any number a caller can act on.
  return { events, unknown, malformed, skipped, abandoned };
}

/** Convenience wrapper for a whole file's contents. */
export function parseTranscriptText(text: string, fallbackSessionId = ''): ParseResult {
  return parseTranscript(text.split('\n'), fallbackSessionId);
}
