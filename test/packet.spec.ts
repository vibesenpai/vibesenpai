/**
 * Quote anchoring in the judge packet. Regression: truncating a merged block once made quotes
 * fall back silently to the block's first `seq`, far from their evidence.
 */

import { describe, expect, it } from 'vitest';
import { agentBudget, buildPacket, buildTurns, renderSession, truncate, turnsForQuote } from '../src/judge/packet.ts';
import type { Event } from '../src/types.ts';

let seq = 0;
function ev(partial: Partial<Event> & Pick<Event, 'turnType'>): Event {
  seq += 1;
  return {
    uuid: `u${seq}`,
    sessionId: 's1',
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...partial,
  } as Event;
}

/**
 * One merged agent block big enough to truncate, with distinct start and end text.
 * Consecutive same-role turns merge, so the budget is `agentBudget(2)` = 5000 chars, not 500.
 */
function longAgentBlock(): { events: Event[]; full: Map<number, string> } {
  seq = 0;
  const events: Event[] = [ev({ turnType: 'user_prompt' })];
  const full = new Map<number, string>([[1, 'go ahead and do the thing']]);

  for (let i = 0; i < 80; i += 1) {
    const e = ev({ turnType: 'assistant_msg' });
    events.push(e);
    full.set(e.seq, i === 0 ? 'FIRST_CONSTITUENT_MARKER' : `filler ${'x'.repeat(120)} ${i}`);
  }
  const last = ev({ turnType: 'assistant_msg' });
  events.push(last);
  full.set(last.seq, 'LAST_CONSTITUENT_MARKER');
  return { events, full };
}

describe('turnsForQuote — the anchor survives truncation', () => {
  it('resolves a quote to its own turn in a block that WAS truncated', () => {
    const { events, full } = longAgentBlock();
    const packet = buildPacket('s1', events, full);

    const agent = packet.turns.find((t) => t.role === 'AGENT' && t.seqs.length > 1);
    expect(agent).toBeDefined();
    const block = agent as NonNullable<typeof agent>;

    // Precondition: this block really was cut.
    expect(block.text).toContain('chars omitted');
    expect(block.seqs.length).toBeGreaterThan(2);

    const lastSeq = block.seqs[block.seqs.length - 1] as number;
    const hits = turnsForQuote(packet, 'LAST_CONSTITUENT_MARKER');

    expect(hits).toEqual([lastSeq]);
    // The actual regression: not the block's first seq.
    expect(hits[0]).not.toBe(block.seqs[0]);
  });

  it('returns every turn a repeated quote appears in, not just the first', () => {
    seq = 0;
    const events = [
      ev({ turnType: 'user_prompt' }),
      ev({ turnType: 'assistant_msg' }),
      ev({ turnType: 'user_prompt' }),
    ];
    const full = new Map<number, string>([
      [1, 'do not add dependencies'],
      [2, 'understood'],
      [3, 'do not add dependencies'],
    ]);
    expect(turnsForQuote(buildPacket('s1', events, full), 'do not add dependencies')).toEqual([1, 3]);
  });

  it('finds nothing for a quote the packet does not contain', () => {
    const { events, full } = longAgentBlock();
    expect(turnsForQuote(buildPacket('s1', events, full), 'NEVER_APPEARED_ANYWHERE')).toEqual([]);
  });

  it('ignores a quote too short to identify a turn', () => {
    const { events, full } = longAgentBlock();
    expect(turnsForQuote(buildPacket('s1', events, full), 'go')).toEqual([]);
  });
});

describe('the developer is never truncated', () => {
  it('keeps a long prompt whole while capping the agent', () => {
    seq = 0;
    const longPrompt = `ask ${'y'.repeat(9000)} end`;
    const events: Event[] = [ev({ turnType: 'user_prompt' })];
    const full = new Map<number, string>([[1, longPrompt]]);
    for (let i = 0; i < 80; i += 1) {
      const e = ev({ turnType: 'assistant_msg' });
      events.push(e);
      full.set(e.seq, `reply ${'z'.repeat(60)} ${i}`);
    }
    const packet = buildPacket('s1', events, full);
    const prompt = packet.turns.find((t) => t.role === 'USER');
    const agent = packet.turns.find((t) => t.role === 'AGENT');

    expect(prompt?.text).toBe(longPrompt);
    expect(agent?.text).toContain('chars omitted');
  });
});

describe('agentBudget — tiers count MERGED turns', () => {
  it('shrinks as the session grows', () => {
    expect(agentBudget(8)).toBe(5000);
    expect(agentBudget(16)).toBe(3000);
    expect(agentBudget(42)).toBe(2000);
    expect(agentBudget(74)).toBe(1000);
    expect(agentBudget(75)).toBe(500);
  });
});

describe('truncate — never cuts through a redaction marker', () => {
  it('does not leave a dangling bracket that redaction would repair', () => {
    const text = `${'a'.repeat(40)}/Users/[USER]${'b'.repeat(40)}`;
    expect(truncate(text, 46)).not.toMatch(/\[USER$/);
  });

  it('does not leave the omission marker where a secret value was', () => {
    const text = `${'a'.repeat(30)}API_KEY: ${'b'.repeat(60)}`;
    expect(truncate(text, 40)).not.toMatch(/API_KEY:\s*$/);
  });
});

describe('isHarnessNoise — a slash command is the developer talking', () => {
  it('keeps a command-name record, which carries the request', () => {
    seq = 0;
    const events = [ev({ turnType: 'user_prompt' })];
    const full = new Map<number, string>([
      [1, '<command-name>/gsd:discuss-phase</command-name> <command-args>23</command-args>'],
    ]);
    expect(renderSession(buildPacket('s1', events, full))).toContain('/gsd:discuss-phase');
  });

  it('still drops a harness task notification', () => {
    seq = 0;
    const events = [ev({ turnType: 'user_prompt' })];
    const full = new Map<number, string>([[1, '<task-notification>done</task-notification>']]);
    expect(buildTurns(events, full)).toEqual([]);
  });
});
