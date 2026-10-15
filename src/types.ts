/**
 * The pinned contracts. See docs/contracts.md for the reasoning.
 *
 * These three shapes are specified ahead of implementation because each one is
 * persisted — if its shape changes, previously stored data becomes wrong in place.
 * Everything else in this codebase is free to be designed while being built.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Events — the normalised stream, aligned to SWE-chat's `conversations` schema
// so our parser output is directly comparable to their 18k real sessions.
// ─────────────────────────────────────────────────────────────────────────────

export type Harness = 'claude-code' | 'codex' | (string & {});

/**
 * SWE-chat's `turn_type` vocabulary. Note that `tool_use` and `tool_result` are
 * *content blocks* inside assistant/user messages in the raw transcript, not
 * top-level record types — the parser flattens them into events.
 */
export type TurnType =
  | 'user_prompt'
  | 'assistant_msg'
  | 'tool_use'
  | 'tool_result'
  | 'queue_operation'
  | 'system';

export type Event = {
  sessionId: string;
  harness: Harness;

  /** The transcript record's own uuid. The only stable identifier. */
  uuid: string;
  /**
   * Parent in the transcript tree. A transcript is a TREE, not a linear log:
   * rewind and compaction create branches, so events must be walked along the
   * active leaf path rather than read in file order.
   */
  parentUuid: string | null;
  /** Index along the active leaf path. Derived on read; never persisted as identity. */
  seq: number;

  /**
   * Subagent events are interleaved into the same file. A parallel fan-out reads
   * the same files legitimately, so sidechain events must be attributed to their
   * subagent or `reading_spiral` fires on every healthy fan-out.
   */
  isSidechain: boolean;
  sidechainId?: string;

  ts: string;
  turnType: TurnType;

  toolName?: string;
  toolCallId?: string;
  filePath?: string;
  command?: string;
  pattern?: string;

  exitCode?: number;
  isError?: boolean;

  /** Interrupts: SWE-chat's `queue_op_subtype` (user_prompt_discarded, …). */
  queueOpSubtype?: string;

  /** Short and redacted. Never raw file contents. */
  textSummary?: string;

  tokens?: { input?: number; output?: number; cacheRead?: number };
};

// ─────────────────────────────────────────────────────────────────────────────
// TurnRef — evidence pointers. By uuid, never by position.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `seq` is a position on the *active leaf path*, and that path changes when a
 * rewind or compaction alters which branch is live. A finding stored as
 * "turns 31, 44" would silently point at different turns after the next rewind.
 * So `uuid` is the identity and `seq` is recomputed for display only.
 */
export type TurnRef = {
  uuid: string;
  sessionId: string;
  seq?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

export type Confidence = 'certain' | 'high' | 'medium' | 'low';

/** How a finding was produced. Never blurred in output: "flagged by rule" and
 *  "flagged by a model at 0.7" are different claims. */
export type Method = 'RULE' | 'RULE+T' | 'LEX' | 'EMB' | 'CLS' | 'NLI' | 'JUDGE' | 'STAT';

/**
 * Four states, and the fourth is the entire safety mechanism. Treating "could
 * not determine" as "did not converge" would fire on every project without
 * tests, every uncommitted branch, and everyone who runs tests in another
 * terminal. Those are invisibility, not rework.
 */
export type Outcome = 'converged' | 'reverted' | 'abandoned' | 'unknown';

/** Which direction is good. `neutral` dimensions carry no value judgment —
 *  more `user_correction` is not a failure; correcting the agent is healthy. */
export type Polarity = 'lower-is-better' | 'higher-is-better' | 'neutral';

export type ArtifactKind = 'prompt' | 'guard' | 'rule';

export type Finding = {
  /** Per-session instance: hash(dimension + sessionId + subject). */
  id: string;
  /**
   * Cross-session identity: hash(dimension + project + subject).
   * The running score, dismissals and the CLAUDE.md audit all operate on this.
   * Keyed on *subject*, never on evidence extent — otherwise a 7-violation
   * finding becomes a different finding at the 8th, and someone who dismissed
   * it gets re-nagged.
   */
  subjectId: string;

  dimension: string;
  /** Human-readable, e.g. `use pnpm, never npm`. */
  subject: string;

  sessionId: string;
  project: string;

  /** Grows over time. Never part of either identity. */
  evidence: TurnRef[];
  occurrences: number;

  confidence: Confidence;
  method: Method;
  backend?: string;
  modelVersion?: string;

  requiresOutcome: boolean;
  outcome?: Outcome;
  polarity: Polarity;

  /** May be empty — report-only findings are a first-class answer. */
  artifacts: ArtifactKind[];

  firstSeen: string;
  lastSeen: string;

  /** Ambient dedup: never surface the same finding twice. */
  surfaced: boolean;
  /** A guarded dimension is suppressed, not improved. */
  suppressedBy?: { kind: 'guard'; since: string };
  dismissed?: { at: string; reason?: string };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton — a versioned format with three consumers:
//   1. model input (~2K tokens, so a window fits a 4K prompt with rubric)
//   2. the evidence shown to the user (`explain` prints it)
//   3. the future team product's wire format (redacted, transmissible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bump when the shape OR the text rendering changes. This is part of the verdict
 * cache key, so a bump invalidates cached verdicts rather than silently reusing
 * ones computed against a different shape.
 */
export const SKELETON_VERSION = 1 as const;

export type SkeletonLine =
  | { k: 'user'; ref: TurnRef; text: string }
  | { k: 'assist'; ref: TurnRef; text?: string }
  | { k: 'tool'; ref: TurnRef; tool: string; target?: string; lines?: number }
  | { k: 'result'; ref: TurnRef; ok: boolean; failures?: number; err?: string }
  | {
      k: 'meta';
      ref: TurnRef;
      kind: 'compaction' | 'interrupt' | 'commit' | 'revert';
    };

export type Skeleton = {
  v: typeof SKELETON_VERSION;
  sessionId: string;
  window: { from: TurnRef; to: TurnRef };
  lines: SkeletonLine[];
  /**
   * Recorded, never hidden. A skeleton that silently dropped the decisive turn
   * would produce a confident wrong verdict.
   */
  elided?: { lines: number; reason: 'token-budget' };
};

// ─────────────────────────────────────────────────────────────────────────────
// Backends — defined now with exactly one null implementation, so the semantic
// tier plugs in later without touching detectors.
// ─────────────────────────────────────────────────────────────────────────────

export type BackendVerdict = {
  label: string;
  confidence: number;
  evidence: string;
};

export interface Backend {
  readonly name: string;
  readonly version: string;
  available(): Promise<boolean>;
  classify(window: Skeleton, labels: string[]): Promise<BackendVerdict>;
}

/** The only backend that exists until M5. Everything degrades to rules. */
export const nullBackend: Backend = {
  name: 'null',
  version: '0',
  available: async () => false,
  classify: async () => {
    throw new Error('no backend available');
  },
};
