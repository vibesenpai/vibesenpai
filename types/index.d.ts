// The insights pane's contract: what it reads from `agentsensei report --json`, and what it keeps.

export type PaneRow = { turn: string; what: string; detail: string; failed: boolean; retry: boolean; asked?: { seq: number; text: string } };

export type PaneJudged = {
  id?: string;
  at: string;
  dimension: string;
  /** Other kinds the finding also is. */
  secondaryDimensions?: string[];
  turns: number[];
  why: string;
  quote?: string;
  asked?: { seq: number; text: string };
  /** Where the expectation was set, as one line. */
  established?: string;
};

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

export type PaneFix = { dimension: string; prompt?: string; memory?: string; config?: { what: string; snippet: string } };

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
};

declare module 'claude-code' {
  interface PluginState {
    agentsensei: {
      snapshot: Shaped<PaneData | null>;
      loadedAt: Shaped<string>;
      stamp: Shaped<string>;
      since: Shaped<string>;
      filter: Shaped<string>;
      open: Shaped<string[]>;
      note: Shaped<string>;
    };
  }
}
