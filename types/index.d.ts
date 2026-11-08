// The insights pane's contract: what it reads from `agentsensei report --json`, and what it keeps.

export type PaneRow = { turn: string; what: string; detail: string; failed: boolean; retry: boolean; asked?: { seq: number; text: string }; ts?: string };

export type PaneJudged = {
  id?: string;
  at: string;
  dimension: string;
  /** Other kinds the finding also is. */
  secondaryDimensions?: string[];
  turns: number[];
  why: string;
  quote?: string;
  /** Who wrote the quote; absent when unknown. Only the developer's words are drawn as a prompt. */
  quoteBy?: 'developer' | 'agent';
  asked?: { seq: number; text: string };
  /** Where the expectation was set, as one line. */
  established?: string;
  /** When the first cited turn was written. */
  turnAt?: string;
};

/** One message of an excerpt, redacted by the CLI. */
export type PaneExcerptEntry = { role: 'developer' | 'agent'; at?: string; cited: boolean; text: string; tools: string[] };

/** The conversation around a finding, read on open; `kept: false` once the harness deleted it. */
export type PaneExcerpt = { kept: true; parts: PaneExcerptEntry[][]; moreBefore: boolean; moreAfter: boolean } | { kept: false };

export type PaneFinding = {
  id: string;
  dimension: string;
  subject: string;
  occurrences: number;
  reasons: { reason: string; count: number }[];
  cost: { written: number };
  evidence: PaneRow[];
};

export type PaneRebuild = { seq: number; tokens: number; cached: number; gapMinutes?: number };

export type PaneSession = {
  sessionId: string;
  project: string;
  lastTs?: string;
  findings: PaneFinding[];
  judged: PaneJudged[];
  stats: { rebuilds?: { count: number; tokens: number; events?: PaneRebuild[] } };
};

export type PaneFix = { dimension: string; prompt?: string; rule?: string; config?: { what: string; snippet: string } };

export type PaneWindow = { times: number; sessions: number };

/** A fix the pane can apply, and what became of it in this project. */
export type PaneFixState = {
  fixId: string;
  dimension: string;
  target: 'session' | 'project-instructions' | 'project-hooks';
  text: string;
  /** Where it lands, as words: a file, or "this session only". */
  destination: string;
  /** The prompt Apply drafts, ending with the marker. */
  request: string;
  applied?: { at: string; sessionId: string };
  inEffect?: boolean;
  before?: PaneWindow;
  since?: PaneWindow;
  cameBack?: { sessionId: string; turn?: number };
};

/** Tokens and Claude Code's own dollar figure; `usdSince` when older calls had none. */
export type PaneSpendWindow = { calls: number; tokensIn: number; tokensOut: number; usdMicros?: number; usdSince?: string; since?: string };

export type PaneSpend = {
  allTime?: PaneSpendWindow;
  last7d?: PaneSpendWindow;
  /** Tokens the automatic reads spent today, against the daily budget. */
  today?: { tokens: number; limit: number };
  /** Never-read sessions past the catch-up, read only on request. */
  older: number;
  catchUp: number;
  enabled: boolean;
  /** `api` when the environment names API or cloud billing; otherwise unknown. */
  billing: 'api' | 'unknown';
};

export type PaneHealth = { job: string; state: string; reason?: string };

export type PaneData = {
  archive: string;
  read: number;
  total: number;
  health: PaneHealth[];
  sessions: PaneSession[];
  recommendations: Record<string, PaneFix>;
  /** The person's verdicts, by finding id. */
  labels?: Record<string, 'mistake' | 'suggestion' | 'wrong'>;
  fixes?: PaneFixState[];
  /** What the judge spent and may spend. */
  spend?: PaneSpend;
  /** Findings set aside. */
  dismissed?: number;
  /** How far the automatic reads have to go. */
  progress?: PaneProgress;
};

/** `target`: sessions the automatic reads cover. `seconds`: today's share at the measured pace. `finishOn`: when the daily limit lets them finish. */
export type PaneProgress = { target: number; seconds?: number; finishOn?: string };

declare module 'claude-code' {
  interface PluginState {
    agentsensei: {
      snapshot: Shaped<PaneData | null>;
      loadedAt: Shaped<string>;
      stamp: Shaped<string>;
      since: Shaped<string>;
      tab: Shaped<string>;
      picked: Shaped<string[]>;
      pictures: Shaped<boolean>;
      drafted: Shaped<string[]>;
      applied: Shaped<Record<string, string>>;
      busy: Shaped<boolean>;
      ticked: Shaped<number>;
      answered: Shaped<Record<string, 'mistake' | 'suggestion' | 'wrong' | 'hidden'>>;
      open: Shaped<string[]>;
      note: Shaped<string>;
      /** By item key, with how many messages either side were asked for. */
      excerpts: Shaped<Record<string, { around: number; excerpt?: PaneExcerpt }>>;
      /** The animation's frame, ticking only while something is loading or reading. */
      frame: Shaped<number>;
    };
  }
}
