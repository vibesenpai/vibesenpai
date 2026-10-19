import { SCHEMA, type Versioned } from './schema.ts';

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
  /**
   * A slash-command echo (`<local-command-stdout>`, `<command-name>`, …).
   * Written as a `user` record with string content, but it is not a human
   * speaking — 13 of 69 "prompts" across 3 real sessions were these. Counting
   * them as prompts inflates every per-prompt rate denominator.
   */
  | 'local_command'
  | 'system';

export type Event = {
  sessionId: string;
  harness: Harness;

  /** The transcript record's own uuid. The only stable identifier. */
  uuid: string;
  /**
   * Parent in the transcript tree. Kept for grouping and for detecting genuinely
   * abandoned subtrees — NOT for sequencing. Measured over real sessions: the
   * longest parentUuid path covers only 78.2% of records, because parallel tool
   * calls legitimately branch. File order is topological and complete, so that
   * is what `seq` follows. See docs/log-formats.md.
   */
  parentUuid: string | null;
  /** Index in file order. Derived on read; never persisted as identity. */
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

  /**
   * Digest of the tool call's full arguments — the only way to tell two calls
   * to the same tool apart.
   *
   * `filePath`, `command` and `pattern` cover Bash, Read, Edit and Grep and
   * nothing else, so without this every `TaskUpdate`, `Agent` or `TaskCreate`
   * call collapses into one indistinguishable signature. Measured: of 19
   * repeated-call runs across 227 sessions, **16 were different calls that
   * merely looked identical** — six separate tasks, seven separate subagents —
   * and `tool_loop` would have reported them at `certain` confidence.
   *
   * A digest rather than the arguments themselves: it answers "same call?",
   * which is all any detector needs, while storing no content. Computed over the
   * redacted form, so it cannot serve as an oracle for a secret that appeared in
   * an argument.
   */
  argHash?: string;

  exitCode?: number;
  isError?: boolean;

  /**
   * Digest of the tool result's **full** output, volatility-normalised.
   *
   * `textSummary` is capped at 200 characters and, measured over 3,748 real
   * results, **59.9% hit that cap** — so comparing summaries compared prefixes,
   * and two different failures sharing an opening line looked identical. This is
   * what `tool_loop` compares instead.
   */
  outHash?: string;
  /** Bytes of output before truncation. A growing log is new information. */
  outBytes?: number;

  /** Interrupts: SWE-chat's `queue_op_subtype` (user_prompt_discarded, …). */
  queueOpSubtype?: string;

  /**
   * Which kind of `system` record this was.
   *
   * `turnType: 'system'` is a catch-all over genuinely different things —
   * compaction residue, cost totals, PR links, file-history bookkeeping. The
   * skeletonizer needs to tell compaction from the rest to emit a
   * `meta: 'compaction'` line, and sniffing `textSummary` prefixes to do it
   * would couple a persisted format to a display string.
   */
  systemKind?: 'compaction' | 'cost-state' | 'pr-link' | 'file-history' | 'other';

  /**
   * Files the harness recorded as **changed** at this point, from
   * `file-history-snapshot`. Tool-agnostic ground truth: it catches an MCP
   * server's write, a custom agent's write, and anything that does not exist
   * yet, because the harness tracks the file rather than the tool.
   *
   * Corroborating rather than primary — it is version-gated. Measured: 0 of 56
   * sessions on harness 1.0 emit snapshots, 1 of 87 on 2.0, but 22 of the 34
   * *editing* sessions on 2.1.
   */
  changedFiles?: string[];

  /**
   * On a branch the user abandoned — by rewinding, or by submitting a prompt and
   * resubmitting it before any reply. **Observed**, not inferred: a `/rewind`
   * leaves the old records in the file with no marker of any kind, so this is
   * derived structurally (see parsers/claude-code.ts).
   *
   * Flagged rather than dropped: detectors ignore these by default, but silently
   * discarding records would hide that work happened at all.
   */
  abandoned?: boolean;

  /** Short and redacted. Never raw file contents. */
  textSummary?: string;

  /**
   * The harness's own billing record, copied verbatim off `message.usage`.
   *
   * The only signal in the format that is exact, universal, and free of text:
   * it is identical for Python, Rust, an MCP server or a custom agent, because
   * it describes the API call rather than the work. Populated on **100% of
   * assistant messages** across the 1,139-session corpus.
   *
   * `cacheCreation` is the load-bearing one. `cacheRead` re-counts the entire
   * prefix on every call, so it grows quadratically with turn count and any
   * ratio built on it is pinned near 1 by construction — measured
   * `read/(read+creation)` runs p10 0.901 to p90 0.985, i.e. an "outlier" is
   * just a short session. `cacheCreation` is what re-ingesting an invalidated
   * prefix actually cost, and it spreads 7.5x p90/p50. See `GRAVEYARD.md`.
   */
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
};

/**
 * The only fields a detector may read.
 *
 * ── Why this is a type and not a convention ─────────────────────────────────
 *
 * `command`, `pattern` and `textSummary` are text, and a rule over text is a
 * rule over an open space: thousands of toolchains, infinite phrasings, and no
 * way to know what was missed. Three detectors were built on them and produced
 * **5 true positives against ~25 false positives** over 1,139 real sessions.
 *
 * Omitting the fields makes `e.command` in a detector a build failure rather
 * than a review comment — the same move as `test/source-hygiene.test.ts`
 * making an invisible character fail the build.
 *
 * A harness string can still *name* a sub-reason, but the **runner** attaches
 * it to an already-valid finding (`src/detect/labels.ts`). Detection never
 * depends on it, so a harness change loses a label and never a finding.
 */
export type StructuralEvent = Omit<Event, 'command' | 'pattern' | 'textSummary'>;

// ─────────────────────────────────────────────────────────────────────────────
// TurnRef — evidence pointers. By uuid, never by position.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `seq` is a derived position, and re-parsing can renumber it — a compaction or
 * rewind changes which records are present, so a finding stored as "turns 31,
 * 44" would silently point somewhere else. `uuid` comes from the transcript and
 * never moves, so it is the identity; `seq` is recomputed for display only.
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

/**
 * What a rate divides by. Deltas are computed on rates, never raw counts: ten
 * sessions this period against ten last period are not comparable if the
 * sessions differ in length.
 */
export type Denominator =
  | 'per-session'
  | 'per-turn'
  | 'per-edit'
  | 'per-success-claim'
  | 'per-tool-call';

/**
 * Which dimensions run by default. `core` is the trust-building set — every
 * member is `certain` or `high` and needs no model.
 */
export type Preset = 'core' | 'standard' | 'all';

export type Finding = Versioned<'finding'> & {
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
  /**
   * One ref per instance — what `occurrences` counts.
   *
   * Distinct from `evidence`, which may cite supporting turns:
   * `inaccurate_self_report` shows both the failing check and the claim, but
   * that is **one** false claim. Tying the count to evidence reported every such
   * finding at double its real size.
   */
  anchors: TurnRef[];
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
 *
 * Sourced from SCHEMA so there is exactly one place to change it.
 */
export const SKELETON_VERSION = SCHEMA.skeleton;

/**
 * Carried by every line kind.
 *
 * `abandoned` is a property of the turn, not a kind of turn, so it rides along
 * rather than becoming a sixth variant. It must be representable: CLAUDE.md
 * requires abandoned work to be flagged rather than dropped, because silently
 * discarding it would hide that the work happened at all. 52 events in the
 * public corpus are on abandoned branches.
 */
type LineCommon = { ref: TurnRef; abandoned?: true };

export type SkeletonLine = LineCommon &
  (
    | { k: 'user'; text: string }
    | { k: 'assist'; text?: string }
    | { k: 'tool'; tool: string; target?: string; lines?: number }
    | { k: 'result'; ok: boolean; failures?: number; err?: string }
    | {
        k: 'meta';
        /**
         * `compaction` comes from the harness's own `summary` record;
         * `interrupt` from a queue operation; `commit` and `revert` are derived
         * from the git command that was run. All four are reachable — an
         * unreachable variant in a persisted format is a trap for the next
         * reader.
         */
        kind: 'compaction' | 'interrupt' | 'commit' | 'revert';
      }
  );

export type Skeleton = Versioned<'skeleton'> & {
  sessionId: string;
  window: { from: TurnRef; to: TurnRef };
  lines: SkeletonLine[];
  /**
   * Recorded, never hidden. A skeleton that silently dropped the decisive turn
   * would produce a confident wrong verdict.
   */
  elided?: { lines: number; reason: 'token-budget' };

  /**
   * Set when this window covers a subagent rather than the main thread.
   * Sidechains are excluded from main-thread windows — a parallel fan-out reads
   * the same files legitimately — but they get their own windows rather than no
   * coverage: 712 events across 99 public transcripts is not a rounding error.
   */
  sidechainId?: string;

  /**
   * Turn types with no line representation (`system` bookkeeping,
   * `local_command` echoes). Counted rather than silently dropped, so a
   * compression ratio cannot be flattered by quietly discarding input.
   */
  dropped?: Record<string, number>;
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
