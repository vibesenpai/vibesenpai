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
import { createHash } from 'node:crypto';
import { redact } from '../redact.ts';
import { outputDigest } from '../normalise.ts';
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
  // Found only in a public corpus of 231 transcripts spanning 42 versions:
  'progress', // hook progress ticks
  'frame-link', // artifact frame reference
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
  /** Present instead of `type` in some exports. */
  role?: string;
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

/**
 * Short, single-line, length-capped — and **redacted**.
 *
 * Redaction happens here, at the point the summary is created, rather than
 * later at display time. Since we keep no transcript copies, an `Event` is
 * already the only version that will exist; a secret that survives into one has
 * nowhere else to be caught.
 *
 * Note the order: redact BEFORE truncating. Truncating first could cut a token
 * in half and leave a fragment that no rule matches — half a key is still a
 * leak, and a shorter one is not a safer one.
 */
/**
 * Every path that reaches an `Event` goes through here.
 *
 * There were three assignment sites and the first fix only covered one, leaking
 * 59 paths from `file-history-*` records. A single choke point means a new site
 * cannot quietly forget.
 */
/**
 * Stable digest of a tool call's arguments.
 *
 * Keys are sorted so that `{a:1,b:2}` and `{b:2,a:1}` are the same call, and the
 * canonical form is redacted before hashing — a hash of a secret should not be
 * usable as a confirmation oracle, and redacting also makes two users' home
 * paths agree, which is what we want for "same call?".
 *
 * Returns undefined for a call with no arguments at all, so a detector can tell
 * "no arguments" from "arguments we failed to read" instead of treating every
 * such call as identical.
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

function cleanPath(p: string | undefined): string | undefined {
  return p === undefined ? undefined : redact(p).text;
}

function summarise(s: unknown, max = 200): string | undefined {
  if (typeof s !== 'string') return undefined;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  const clean = redact(flat).text;
  if (clean.length <= max) return clean;
  // The marker is space-separated because `/home/…` would otherwise read `…` as
  // the username and mask it to `/home/[USER]`, inventing a path segment that
  // was never there.
  return redactToFixedPoint(`${clean.slice(0, max)} …`);
}

/**
 * Redact until the text stops changing.
 *
 * One pass suffices for whole text, but truncation can leave a dangling
 * construct whose marker the next pass then consumes: cutting
 * `API_TOKEN=secret` at the `=` leaves `API_TOKEN= …`, and `secret-assignment`
 * allows whitespace after the separator, so it swallows the marker as the value.
 * No secret is exposed either way — redaction already ran before the cut — but
 * the output would not be stable.
 *
 * Iterating makes the invariant hold *by construction*: every emitted summary
 * is a fixed point of `redact`. That is what lets scripts/verify-corpus.ts treat
 * any re-redaction change as proof a field reached an `Event` without passing
 * the redactor — the bug that leaked 347 home paths through `filePath`.
 *
 * The bound is a guard against a future rule pair that oscillates, not an
 * expectation; observed convergence is one or two passes.
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
 * Pull the most useful identifying argument out of a tool call.
 *
 * These are **structured evidence fields**, not summaries — `constraint_decay`
 * compares `command` against a stated rule, so `npm install lodash` must survive
 * verbatim. But they routinely contain absolute paths, which carry the username.
 *
 * So they get the same redactor as everything else: it rewrites `/Users/alice`
 * to `~` while leaving the command and path structure intact. Measured on real
 * transcripts, 347 events carried a raw home path through these two fields alone
 * — they bypass `summarise()`, so forgetting them leaked silently.
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
 * Which subagent each sidechain record belongs to.
 *
 * `isSidechain` says only *that* a record is a subagent's work, never *whose*.
 * Measured on the public corpus: 712 sidechain events across 90 files, and the
 * transcript carries no subagent id on any of them. Without this, every
 * subagent in a file collapses into one interleaved pseudo-thread — and since
 * the whole reason sidechains are separated is that a parallel fan-out reads the
 * same files legitimately, merging two subagents' reads reproduces exactly the
 * `reading_spiral` false positive the separation exists to prevent.
 *
 * A subagent's work is a contiguous subtree, so the topmost sidechain ancestor
 * identifies the invocation that spawned it. That root uuid becomes the id.
 */
export function attributeSidechains(nodes: TreeNode[]): Map<string, string> {
  const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
  const out = new Map<string, string>();

  for (const n of nodes) {
    if (!n.isSidechain) continue;
    let top = n.uuid;
    let cur: string | null = n.parentUuid;
    // Cycles cannot occur in a well-formed transcript, but a corrupt file must
    // not hang the parser — Principle Zero outranks completeness here.
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
 * tool calls in a real session.
 *
 * **Sidechains are excluded explicitly.** A subagent's work hangs off the main
 * spine and carries its own injected prompt, so the human-prompt test would
 * classify an entire fan-out as abandoned. On a public corpus of 99
 * sidechain-bearing transcripts this happened to produce 0 false positives — but
 * only incidentally, which is the worst reason for something to be correct. The
 * exclusion makes it intentional: a subagent branch was never a branch the user
 * walked away from.
 *
 * Verified on 231 public transcripts across 42 harness versions plus 4 local
 * sessions: 52 abandoned main-thread events, 0 in any sidechain.
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
      if (child.isSidechain) continue; // a subagent's work, not an abandoned branch
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

    // Some exports omit `type` and carry only `role`. Observed in 2 of 160
    // SWE-chat transcripts: 103 records, 24 of them real human prompts, all
    // silently counted as `(missing)` and dropped. The shape is otherwise a
    // normal user/assistant record, so the role supplies the type.
    const type = r.type ?? (r.role === 'user' || r.role === 'assistant' ? r.role : '(missing)');
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
        isSidechain: r.isSidechain === true,
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
              // Hash the FULL output before `sum()` truncates it to 200 chars.
              // Redacted first, so the digest cannot confirm a secret.
              const outHash = text === undefined ? undefined : outputDigest(redact(text).text);
              push('tool_result', {
                ...(toolName !== undefined ? { toolName } : {}),
                ...(b.tool_use_id !== undefined ? { toolCallId: b.tool_use_id } : {}),
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(outHash !== undefined ? { outHash } : {}),
                ...(text !== undefined ? { outBytes: Buffer.byteLength(text) } : {}),
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
                ...(argDigest(b.input) !== undefined
                  ? { argHash: argDigest(b.input) as string }
                  : {}),
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
          systemKind: 'other',
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
        // The harness tracks files, not tools, so a rising `version` is
        // tool-agnostic proof that a file changed — it catches an MCP server's
        // write and anything else a name allowlist cannot know about.
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
          // A first sighting at version 1 is the snapshot being established, not
          // an edit; only an increase proves a change during this session.
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

      // ── Types that appear only in the public corpus ─────────────────────
      //
      // None of these occur in local transcripts, which is why testing against
      // someone else's data mattered: three carry signal the detectors want,
      // and all three were being silently counted as "unknown".

      case 'summary': {
        // What compaction leaves behind. `leafUuid` anchors it to the turn it
        // replaced — the reference `context_rationale_erosion` needs to tell a
        // dropped rationale from a dropped action.
        const sm = r as { summary?: unknown; leafUuid?: unknown };
        push('system', {
          systemKind: 'compaction',
          ...sum(sm.summary),
          ...(typeof sm.leafUuid === 'string' ? { toolCallId: sm.leafUuid } : {}),
        });
        break;
      }

      case 'cost-state': {
        // Session totals. The lines-added/removed counters are a real progress
        // signal for outcome classification, and this is where
        // `spend_without_progress` finally gets an input.
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
        // A pull request was opened — one of the strongest convergence signals
        // available. Work that reached a PR was not abandoned.
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

  // Counts abandoned EVENTS, not abandoned records — the dead subtree also
  // contains noise records that never become events, and reporting those would
  // not match any number a caller can act on.
  return { events, unknown, malformed, skipped, abandoned };
}

/** Convenience wrapper for a whole file's contents. */
export function parseTranscriptText(text: string, fallbackSessionId = ''): ParseResult {
  return parseTranscript(text.split('\n'), fallbackSessionId);
}
