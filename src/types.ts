import type { Versioned } from './schema.ts';

/**
 * The pinned contracts: Event, Finding, Skeleton. Each is persisted, so a shape change corrupts
 * stored data in place. Reasoning: docs/contracts.md.
 */

// Events: the normalised stream, aligned to SWE-chat's `conversations` schema.

export type Harness = 'claude-code' | 'codex' | (string & {});

/** SWE-chat's `turn_type` vocabulary. `tool_use`/`tool_result` are content blocks flattened into events. */
export type TurnType =
  | 'user_prompt'
  | 'assistant_msg'
  | 'tool_use'
  | 'tool_result'
  | 'queue_operation'
  /** A slash-command echo written as a `user` record. Not a human prompt; excluded from per-prompt rates. */
  | 'local_command'
  | 'system';

export type Event = {
  sessionId: string;
  harness: Harness;

  /** The transcript record's own uuid. The only stable identifier. */
  uuid: string;
  /** Parent in the transcript tree. For grouping, not sequencing: see docs/log-formats.md. */
  parentUuid: string | null;
  /** Index in file order. Derived on read; never persisted as identity. */
  seq: number;

  /** Subagent events share the file; attribute them to their subagent. */
  isSidechain: boolean;
  sidechainId?: string;

  /** Optional: some records (e.g. `file-history-snapshot`) have none. Validated at the parser boundary. */
  ts?: string;
  turnType: TurnType;

  toolName?: string;
  toolCallId?: string;
  filePath?: string;
  command?: string;
  pattern?: string;

  /**
   * Digest of the call's full redacted arguments: tells two calls to the same tool apart
   * without storing content.
   */
  argHash?: string;

  /** Byte length of the serialised arguments; the cost input. Runs slightly high (newlines are `\n`). */
  argBytes?: number;

  /**
   * The API response this event came from. One response spans several records repeating the
   * same `usage`, so sum tokens once per response, not per record.
   */
  responseId?: string;

  exitCode?: number;
  isError?: boolean;

  /** Digest of the full, volatility-normalised output (`textSummary` is capped at 200 chars). */
  outHash?: string;
  /** Bytes of output before truncation. A growing log is new information. */
  outBytes?: number;

  /** Interrupts: SWE-chat's `queue_op_subtype` (user_prompt_discarded, …). */
  queueOpSubtype?: string;

  /** Which kind of `system` record, so nothing has to sniff `textSummary`. */
  systemKind?: 'compaction' | 'cost-state' | 'pr-link' | 'file-history' | 'other';

  /** The harness's exact before/after context size, from `compact_boundary` records only. */
  compaction?: { preTokens: number; postTokens: number };

  /** Files the harness recorded as changed (`file-history-snapshot`). Version-gated, so corroborating only. */
  changedFiles?: string[];

  /** On a branch the user abandoned (rewind or resubmit). Flagged, not dropped; see parsers/claude-code.ts. */
  abandoned?: boolean;

  /**
   * Who rejected a failed call, from the harness's error envelope (the format has no error codes).
   * Only `tool` is agent waste; `cascade` means the call never ran. See CLAUDE.md "A detector reads structure".
   */
  failureKind?: 'tool' | 'denied' | 'hook' | 'permission' | 'cascade' | 'other';

  /**
   * The pipeline ends in `head`/`tail`, so `outHash` covers a prefix. Other truncating forms
   * (`sed -n`, `cut`, …) are not detected.
   */
  truncatesOwnOutput?: boolean;

  /** Short and redacted. Never raw file contents. */
  textSummary?: string;

  /**
   * A command the developer invoked (`invocation`, text `/name args`) or the instructions it expanded to
   * (`instructions`). Set by each harness's parser; never an agent-loaded skill.
   */
  devCommand?: { name: string; part: 'invocation' | 'instructions' };

  /** Fix ids a developer prompt carries in vibesenpai's marker: the moment those fixes were applied. */
  fixApplied?: string[];

  /**
   * `message.usage`, verbatim. `cacheRead` re-counts the whole prefix per call, so ratios on it
   * are meaningless; `cacheCreation` is the real cost. See GRAVEYARD.md.
   */
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
};

/**
 * The only fields a detector may read: reading command text in a detector is a compile error.
 * Why: CLAUDE.md "A detector reads structure".
 */
export type StructuralEvent = Omit<Event, 'command' | 'pattern' | 'textSummary' | 'devCommand'>;

/** Evidence pointer. `uuid` is the identity; `seq` can renumber on re-parse and is display only. */
export type TurnRef = {
  uuid: string;
  sessionId: string;
  seq?: number;
};

// Findings

export type Confidence = 'certain' | 'high' | 'medium' | 'low';

/** How a finding was produced. Never blurred in output. */
export type Method = 'RULE' | 'RULE+T' | 'LEX' | 'EMB' | 'CLS' | 'NLI' | 'JUDGE' | 'STAT';

/** `unknown` is the safety valve: "could not determine" must never read as "did not converge". */
export type Outcome = 'converged' | 'reverted' | 'abandoned' | 'unknown';

/** Which direction is good. `neutral` carries no value judgment. */
export type Polarity = 'lower-is-better' | 'higher-is-better' | 'neutral';

/** What a rate divides by. Deltas compare rates, never raw counts. */
export type Denominator =
  | 'per-session'
  | 'per-turn'
  | 'per-edit'
  | 'per-success-claim'
  | 'per-tool-call';

/** Which dimensions run by default. `core` is all `certain`/`high` and needs no model. */
export type Preset = 'core' | 'standard' | 'all';

export type Finding = Versioned<'finding'> & {
  /** Per-session instance: hash(dimension + sessionId + subject). */
  id: string;
  /**
   * Cross-session identity: hash(dimension + project + subject). Keyed on subject, never on
   * evidence extent, so a dismissal survives the finding growing.
   */
  subjectId: string;

  dimension: string;
  /** Human-readable, e.g. `use pnpm, never npm`. */
  subject: string;

  sessionId: string;
  project: string;

  /** Grows over time. Never part of either identity. */
  evidence: TurnRef[];
  /** One ref per instance; what `occurrences` counts. `evidence` may also cite supporting turns. */
  anchors: TurnRef[];
  occurrences: number;

  confidence: Confidence;
  method: Method;
  backend?: string;
  modelVersion?: string;

  requiresOutcome: boolean;
  outcome?: Outcome;
  polarity: Polarity;

  /** Harness reasons with counts, attached by the runner after detection (`src/detect/labels.ts`). */
  reasons?: Record<string, number>;

  firstSeen: string;
  lastSeen: string;

  /** Ambient dedup: never surface the same finding twice. */
  surfaced: boolean;
  /** A guarded dimension is suppressed, not improved. */
  suppressedBy?: { kind: 'guard'; since: string };
  dismissed?: { at: string; reason?: string };
};

// Skeleton: versioned; read by the model, shown as evidence, and redacted for transmission.

/** Carried by every line kind. Abandoned work is flagged, never dropped. */
type LineCommon = { ref: TurnRef; abandoned?: true };

export type SkeletonLine = LineCommon &
  (
    | { k: 'user'; text: string }
    | { k: 'assist'; text?: string }
    | { k: 'tool'; tool: string; target?: string; lines?: number }
    | { k: 'result'; ok: boolean; failures?: number; err?: string }
    | {
        k: 'meta';
        /** `compaction` from a summary record, `interrupt` from a queue op, `commit`/`revert` from git. */
        kind: 'compaction' | 'interrupt' | 'commit' | 'revert';
      }
  );

export type Skeleton = Versioned<'skeleton'> & {
  sessionId: string;
  window: { from: TurnRef; to: TurnRef };
  lines: SkeletonLine[];
  /** Recorded, never hidden. */
  elided?: { lines: number; reason: 'token-budget' };

  /** Set when this window covers a subagent; sidechains get their own windows. */
  sidechainId?: string;

  /** Turn types with no line representation, counted rather than silently dropped. */
  dropped?: Record<string, number>;
};
