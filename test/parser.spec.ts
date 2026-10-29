import { describe, expect, it } from 'vitest';
import { parseTranscript, parseTranscriptText, withFullText } from '../src/parsers/claude-code.ts';

const j = (o: unknown): string => JSON.stringify(o);

describe('parser — record selection', () => {
  it('skips noise types but still parses records that follow them', () => {
    // Attachments sit inside the parentUuid chain; filtering them first breaks the tree.
    const text = [
      j({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'hello' } }),
      j({ type: 'attachment', uuid: 'b', parentUuid: 'a', attachment: { type: 'hook_success' } }),
      j({ type: 'assistant', uuid: 'c', parentUuid: 'b', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n');

    const r = parseTranscriptText(text);
    expect(r.events.map((e) => e.turnType)).toEqual(['user_prompt', 'assistant_msg']);
    expect(r.skipped['attachment']).toBe(1);
    // the record after the attachment is still reached
    expect(r.events[1]?.uuid).toBe('c');
  });

  it('counts unknown record types without crashing', () => {
    const text = [
      j({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'hi' } }),
      j({ type: 'some-future-type', uuid: 'b', parentUuid: 'a' }),
    ].join('\n');
    const r = parseTranscriptText(text);
    expect(r.events).toHaveLength(1);
    expect(r.unknown['some-future-type']).toBe(1);
  });

  it('counts malformed lines without crashing', () => {
    const text = ['not json', j({ type: 'user', uuid: 'a', message: { content: 'hi' } }), '{broken'].join('\n');
    const r = parseTranscriptText(text);
    expect(r.malformed).toBe(2);
    expect(r.events).toHaveLength(1);
  });
});

describe('parser — content block flattening', () => {
  it('flattens multiple tool_use blocks in one assistant record', () => {
    const text = j({
      type: 'assistant',
      uuid: 'a',
      parentUuid: null,
      message: {
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'thinking', thinking: 'considering' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/b.ts' } },
        ],
      },
    });
    const r = parseTranscriptText(text);
    expect(r.events.map((e) => e.turnType)).toEqual(['assistant_msg', 'tool_use', 'tool_use']);
    expect(r.events[1]?.command).toBe('npm test');
    expect(r.events[2]?.filePath).toBe('/a/b.ts');
    expect(r.events[1]?.tokens).toEqual({ input: 10, output: 5 });
  });

  it('distinguishes a human prompt from a tool_result in a user record', () => {
    const text = [
      j({ type: 'user', uuid: 'a', message: { content: 'fix the bug' } }),
      j({
        type: 'user',
        uuid: 'b',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
    ].join('\n');
    const r = parseTranscriptText(text);
    expect(r.events.map((e) => e.turnType)).toEqual(['user_prompt', 'tool_result']);
  });

  it('pairs tool_result back to its tool by tool_use_id, not tree position', () => {
    const text = [
      j({
        type: 'assistant',
        uuid: 'a',
        message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }] },
      }),
      j({
        type: 'user',
        uuid: 'b',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'files' }] },
      }),
    ].join('\n');
    const r = parseTranscriptText(text);
    const result = r.events.find((e) => e.turnType === 'tool_result');
    expect(result?.toolName).toBe('Bash');
    expect(result?.toolCallId).toBe('toolu_9');
  });
});

describe('parser — failure signals', () => {
  it('extracts the exit code from Bash output and marks it an error', () => {
    const text = j({
      type: 'user',
      uuid: 'a',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\nno such file' }],
      },
    });
    const e = parseTranscriptText(text).events[0];
    expect(e?.exitCode).toBe(1);
    expect(e?.isError).toBe(true);
  });

  it('treats exit code 0 as success', () => {
    const text = j({
      type: 'user',
      uuid: 'a',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 0\nfine' }] },
    });
    const e = parseTranscriptText(text).events[0];
    expect(e?.exitCode).toBe(0);
    expect(e?.isError).toBeUndefined();
  });

  it('honours is_error even with no exit code', () => {
    const text = j({
      type: 'user',
      uuid: 'a',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
    });
    expect(parseTranscriptText(text).events[0]?.isError).toBe(true);
  });

  it('captures queue-operation as the interrupt signal', () => {
    const text = j({
      type: 'queue-operation',
      uuid: 'a',
      operation: 'enqueue',
      content: 'actually use pnpm',
      timestamp: '2026-10-15T00:00:00Z',
    });
    const e = parseTranscriptText(text).events[0];
    expect(e?.turnType).toBe('queue_operation');
    expect(e?.queueOpSubtype).toBe('enqueue');
  });

  it('captures file-history-snapshot with its tracked file', () => {
    const text = j({
      type: 'file-history-snapshot',
      uuid: 'a',
      snapshot: { trackedFileBackups: { '/a/b.ts': { version: 2 } } },
    });
    const e = parseTranscriptText(text).events[0];
    expect(e?.filePath).toBe('/a/b.ts');
  });
});

describe('parser — sequencing', () => {
  it('sequences by file order, which is already topological', () => {
    // File order has no parent-after-child violations; the parentUuid path is incomplete.
    const text = [
      j({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'one' } }),
      j({ type: 'user', uuid: 'b', parentUuid: 'a', message: { content: 'two' } }),
      j({ type: 'user', uuid: 'c', parentUuid: 'a', message: { content: 'three' } }),
    ].join('\n');
    const r = parseTranscriptText(text);
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    // both children of `a` survive — parallel tool calls must not be dropped
    expect(r.events).toHaveLength(3);
  });

  it('keeps parentUuid for later grouping and rewind detection', () => {
    const text = j({ type: 'user', uuid: 'b', parentUuid: 'a', message: { content: 'x' } });
    expect(parseTranscriptText(text).events[0]?.parentUuid).toBe('a');
  });

  it('marks sidechain events so a fan-out is not read as a reading spiral', () => {
    const text = j({
      type: 'assistant',
      uuid: 'a',
      isSidechain: true,
      message: { content: [{ type: 'text', text: 'subagent' }] },
    });
    expect(parseTranscriptText(text).events[0]?.isSidechain).toBe(true);
  });

  it('falls back to the given session id when a record omits it', () => {
    const text = j({ type: 'user', uuid: 'a', message: { content: 'x' } });
    expect(parseTranscriptText(text, 'sess-1').events[0]?.sessionId).toBe('sess-1');
  });
});

describe('parser — abandoned branches', () => {
  // A rewind leaves pre-rewind records in the file, unmarked.
  const rewound = [
    j({ type: 'user', uuid: 'root', parentUuid: null, message: { content: 'hey' } }),
    j({ type: 'attachment', uuid: 'att', parentUuid: 'root', attachment: {} }),
    // branch A — abandoned by the rewind. Note it HAS assistant replies.
    j({ type: 'user', uuid: 'a1', parentUuid: 'att', message: { content: 'first try' } }),
    j({
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'a1',
      message: { content: [{ type: 'text', text: 'reply to first' }] },
    }),
    j({ type: 'user', uuid: 'a3', parentUuid: 'a2', message: { content: 'more of first' } }),
    // branch B — live, continues to the end of the file
    j({ type: 'user', uuid: 'b1', parentUuid: 'att', message: { content: 'second try' } }),
    j({
      type: 'assistant',
      uuid: 'b2',
      parentUuid: 'b1',
      message: { content: [{ type: 'text', text: 'reply to second' }] },
    }),
  ].join('\n');

  it('flags the abandoned branch and leaves the live one alone', () => {
    const r = parseTranscriptText(rewound);
    const dead = r.events.filter((e) => e.abandoned).map((e) => e.uuid);
    expect(dead.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(r.events.filter((e) => !e.abandoned).map((e) => e.uuid).sort()).toEqual([
      'b1', 'b2', 'root',
    ]);
    expect(r.abandoned).toBe(3);
  });

  it('flags abandoned work even though it HAS assistant replies', () => {
    // "No assistant descendant" misses a rewind: dead branches have replies.
    const r = parseTranscriptText(rewound);
    const deadAssistant = r.events.find((e) => e.abandoned && e.turnType === 'assistant_msg');
    expect(deadAssistant).toBeDefined();
  });

  it('does NOT flag a parallel tool call as abandoned', () => {
    // A tool_use and its tool_result share a parent; both are live.
    const parallel = [
      j({
        type: 'assistant',
        uuid: 'p',
        parentUuid: null,
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'a' } }] },
      }),
      j({
        type: 'assistant',
        uuid: 'c1',
        parentUuid: 'p',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'b' } }] },
      }),
      j({
        type: 'user',
        uuid: 'c2',
        parentUuid: 'p',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
      j({
        type: 'user',
        uuid: 'c3',
        parentUuid: 'c1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
      }),
    ].join('\n');
    const r = parseTranscriptText(parallel);
    expect(r.abandoned).toBe(0);
    expect(r.events.every((e) => !e.abandoned)).toBe(true);
  });

  it('flags a prompt submitted then resubmitted with no reply', () => {
    // Identical prompt resubmitted with no reply to the first.
    const resubmit = [
      j({ type: 'system', uuid: 's', parentUuid: null, subtype: 'x' }),
      j({ type: 'user', uuid: 'first', parentUuid: 's', message: { content: 'same text' } }),
      j({ type: 'attachment', uuid: 'h1', parentUuid: 'first', attachment: {} }),
      j({ type: 'user', uuid: 'second', parentUuid: 's', message: { content: 'same text' } }),
      j({
        type: 'assistant',
        uuid: 'reply',
        parentUuid: 'second',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
    ].join('\n');
    const r = parseTranscriptText(resubmit);
    expect(r.events.filter((e) => e.abandoned).map((e) => e.uuid)).toEqual(['first']);
  });
});

describe('parser — slash-command echoes are not prompts', () => {
  it('classifies local-command wrappers as local_command', () => {
    const text = [
      j({ type: 'user', uuid: 'a', message: { content: 'a real question' } }),
      j({ type: 'user', uuid: 'b', message: { content: '<command-name>/plugin</command-name>' } }),
      j({ type: 'user', uuid: 'c', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }),
    ].join('\n');
    const r = parseTranscriptText(text);
    expect(r.events.map((e) => e.turnType)).toEqual([
      'user_prompt',
      'local_command',
      'local_command',
    ]);
  });
});

describe('parser — redacts at construction, not at display', () => {
  // No transcript copy is kept, so the Event is the only place to catch a secret.
  it('redacts a secret in a user prompt', () => {
    const text = j({
      type: 'user',
      uuid: 'a',
      message: { content: 'use this key sk-ant-api03-AbCdEf1234567890xyz please' },
    });
    const e = parseTranscriptText(text).events[0];
    expect(e?.textSummary).not.toContain('sk-ant-api03');
    expect(e?.textSummary).toContain('[REDACTED:api-key]');
  });

  it('redacts a secret echoed in a tool result', () => {
    const text = j({
      type: 'user',
      uuid: 'a',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'DB_PASSWORD=hunter2\nok' },
        ],
      },
    });
    expect(parseTranscriptText(text).events[0]?.textSummary).not.toContain('hunter2');
  });

  it('redacts before truncating, so a long secret cannot survive as a fragment', () => {
    // Truncating first could leave a key fragment no rule matches.
    const secret = `sk-ant-api03-${'A'.repeat(300)}`;
    const text = j({ type: 'user', uuid: 'a', message: { content: `key ${secret} end` } });
    const out = parseTranscriptText(text).events[0]?.textSummary ?? '';
    expect(out).not.toContain('AAAAAAAAAA');
    expect(out).toContain('[REDACTED:api-key]');
  });

  it('keeps the command evidence intact while redacting around it', () => {
    const text = j({
      type: 'assistant',
      uuid: 'a',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm install lodash' } },
        ],
      },
    });
    const e = parseTranscriptText(text).events[0];
    // `command` is evidence and survives verbatim.
    expect(e?.command).toBe('npm install lodash');
  });
});

describe('parser — structured evidence fields are redacted too', () => {
  it('rewrites a home path in filePath while keeping the path structure', () => {
    // These bypass summarise(), so they need their own redaction.
    const home = process.env.HOME ?? '/Users/nobody';
    const text = j({
      type: 'assistant',
      uuid: 'a',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${home}/app/src/auth.ts` } },
        ],
      },
    });
    const e = parseTranscriptText(text).events[0];
    expect(e?.filePath).toBe('~/app/src/auth.ts');
  });

  it('keeps the command verbatim apart from the path', () => {
    const home = process.env.HOME ?? '/Users/nobody';
    const text = j({
      type: 'assistant',
      uuid: 'a',
      message: {
        content: [
          {
            type: 'tool_use', id: 't1', name: 'Bash',
            input: { command: `cd ${home}/app && npm install lodash` },
          },
        ],
      },
    });
    // `npm install` must survive — constraint_decay compares exactly this.
    expect(parseTranscriptText(text).events[0]?.command).toBe('cd ~/app && npm install lodash');
  });
});

describe('parser — a sidechain is never an abandoned branch', () => {
  it('does not flag a subagent fan-out as abandoned', () => {
    // A subagent carries its own injected prompt, which the human-prompt test would misread.
    const text = [
      j({ type: 'user', uuid: 'm1', parentUuid: null, message: { content: 'do the thing' } }),
      // subagent branch off the main thread, with its own prompt
      j({ type: 'user', uuid: 's1', parentUuid: 'm1', isSidechain: true, message: { content: 'subagent task' } }),
      j({
        type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true,
        message: { content: [{ type: 'text', text: 'subagent reply' }] },
      }),
      // main thread continues past the fan-out
      j({
        type: 'assistant', uuid: 'm2', parentUuid: 'm1',
        message: { content: [{ type: 'text', text: 'main reply' }] },
      }),
    ].join('\n');

    const r = parseTranscriptText(text);
    expect(r.abandoned).toBe(0);
    expect(r.events.filter((e) => e.isSidechain)).toHaveLength(2);
  });
});

describe('parser — truncation must preserve the redaction fixed point', () => {
  // The cut marker must not merge into the fragment before it: re-redacting emitted text
  // must be a no-op (the invariant scripts/verify-corpus.ts relies on).
  const summaryOf = (content: string): string => {
    const text = [
      j({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'go' } }),
      j({
        type: 'user',
        uuid: 'b',
        parentUuid: 'a',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      }),
    ].join('\n');
    const e = parseTranscriptText(text).events.find((x) => x.toolCallId === 't1');
    return e?.textSummary ?? '';
  };

  it('does not invent a username when the cut lands on a path prefix', () => {
    // Pad so character 200 falls immediately after `/home/`.
    const padded = `${'x'.repeat(200 - '/home/'.length)}/home/bob/project`;
    const out = summaryOf(padded);
    expect(out).not.toContain('/home/[USER]'); // nothing was there to mask
    expect(out).toContain('/home/');
  });

  it('closes a replacement token the cut split in half', () => {
    const padded = `${'x'.repeat(190)}API_TOKEN=supersecretvalue`;
    const out = summaryOf(padded);
    expect(out).not.toContain('supersecret');
    expect(out).not.toMatch(/\[REDACTED:[a-z-]*$/); // no dangling fragment
  });

  it('is a fixed point of redact — the property the corpus gate relies on', async () => {
    const { redact } = await import('../src/redact.ts');
    const cases = [
      `${'x'.repeat(194)}/home/bob/project`,
      `${'y'.repeat(190)}API_TOKEN=hunter2abcdef`,
      `${'z'.repeat(195)}/Users/alice/notes.md`,
      `${'w'.repeat(180)}contact me@example.com now`,
    ];
    for (const c of cases) {
      const out = summaryOf(c);
      expect(out).not.toBe('');
      expect(redact(out).text).toBe(out);
    }
  });

  it('still marks that truncation happened', () => {
    expect(summaryOf('q'.repeat(400))).toMatch(/…$/);
  });
});

describe('parser — sidechain attribution', () => {
  // `isSidechain` says only THAT a record is subagent work, never whose.
  // Records carry no subagent id, so one is derived per subtree.
  it('attributes each sidechain record to its subtree root', () => {
    const text = [
      j({ type: 'user', uuid: 'main', parentUuid: null, message: { content: 'go' } }),
      j({ type: 'assistant', uuid: 'spawn', parentUuid: 'main', message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: {} }] } }),
      // subagent A
      j({ type: 'assistant', uuid: 'a1', parentUuid: 'spawn', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.ts' } }] } }),
      j({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'y.ts' } }] } }),
      // subagent B, a separate subtree off the same spawn point
      j({ type: 'assistant', uuid: 'b1', parentUuid: 'spawn', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'c', name: 'Read', input: { file_path: 'z.ts' } }] } }),
    ].join('\n');

    const byUuid = new Map(parseTranscriptText(text).events.map((e) => [e.uuid, e]));
    // Both of A's records share one id; B's differs.
    expect(byUuid.get('a1')?.sidechainId).toBe('a1');
    expect(byUuid.get('a2')?.sidechainId).toBe('a1');
    expect(byUuid.get('b1')?.sidechainId).toBe('b1');
    expect(byUuid.get('a1')?.sidechainId).not.toBe(byUuid.get('b1')?.sidechainId);
  });

  it('leaves main-thread records unattributed', () => {
    const text = [
      j({ type: 'user', uuid: 'main', parentUuid: null, message: { content: 'go' } }),
    ].join('\n');
    expect(parseTranscriptText(text).events[0]?.sidechainId).toBeUndefined();
  });
});

describe('parser — records that carry role instead of type', () => {
  // Some SWE-chat records have `role` but no `type`.
  it('infers the type from role', () => {
    const text = [
      j({ role: 'user', uuid: 'a', parentUuid: null, message: { content: 'review the branch' } }),
      j({ role: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: [{ type: 'text', text: 'on it' }] } }),
    ].join('\n');
    const r = parseTranscriptText(text);
    expect(r.events.map((e) => e.turnType)).toEqual(['user_prompt', 'assistant_msg']);
    expect(r.unknown['(missing)']).toBeUndefined();
  });

  it('still counts a record with neither type nor a usable role', () => {
    const r = parseTranscriptText(j({ uuid: 'a', parentUuid: null, foo: 1 }));
    expect(r.unknown['(missing)']).toBe(1);
  });

  it('prefers an explicit type over role when both are present', () => {
    const r = parseTranscriptText(
      j({ type: 'queue-operation', role: 'user', uuid: 'a', parentUuid: null, operation: 'remove' }),
    );
    expect(r.events[0]?.turnType).toBe('queue_operation');
  });
});

describe('compaction, argBytes, and the repeated usage', () => {
  it('detects a compact_boundary record and keeps its token counts', () => {
    const r = parseTranscriptText(
      j({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'a',
        parentUuid: null,
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 30 },
      }),
    );
    const c = r.events.find((e) => e.systemKind === 'compaction');
    expect(c).toBeDefined();
    // The harness's own accounting, not ours.
    expect(c?.compaction).toEqual({ preTokens: 1000, postTokens: 30 });
  });

  it('does not read a compaction summary as a user prompt', () => {
    const r = parseTranscriptText(
      j({
        type: 'user',
        uuid: 'b',
        parentUuid: null,
        isCompactSummary: true,
        message: { content: 'This session is being continued from a previous conversation.' },
      }),
    );
    // `edit_retry` ends a span at the next prompt, so misreading it truncates spans.
    expect(r.events.filter((e) => e.turnType === 'user_prompt')).toHaveLength(0);
    expect(r.events.filter((e) => e.systemKind === 'compaction')).toHaveLength(1);
  });

  it('records argBytes, and one responseId across a response\'s blocks', () => {
    const input = { file_path: '/a.ts', old_string: 'x', new_string: 'y' };
    const r = parseTranscriptText(
      j({
        type: 'assistant',
        uuid: 'c',
        parentUuid: null,
        message: {
          id: 'msg_1',
          usage: { output_tokens: 500 },
          content: [
            { type: 'text', text: 'doing it' },
            { type: 'tool_use', id: 'tc1', name: 'Edit', input },
          ],
        },
      }),
    );
    const call = r.events.find((e) => e.turnType === 'tool_use');
    expect(call?.argBytes).toBe(Buffer.byteLength(JSON.stringify(input)));
    // One response, so its `usage` is counted once.
    expect(new Set(r.events.map((e) => e.responseId))).toEqual(new Set(['msg_1']));
  });
});

describe('project instructions, captured for the judge only', () => {
  const base = { sessionId: 's1', version: '2.1.296', timestamp: '2026-10-20T10:00:00.000Z' };
  const lines = [
    { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'start' } },
    {
      ...base, type: 'attachment', uuid: 'a1', parentUuid: 'u1',
      attachment: {
        type: 'instructions',
        files: [
          { path: '/repo/CLAUDE.md', type: 'Project', content: 'Never push.\nAPI_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
          { path: '/home/me/.claude/projects/x/memory/MEMORY.md', type: 'AutoMem', content: '- keep comments short' },
        ],
      },
    },
    { ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'next' } },
    {
      ...base, type: 'attachment', uuid: 'a2', parentUuid: 'u2',
      attachment: { type: 'nested_memory', path: '/repo/.claude/rules/hooks.md', content: { path: '/repo/.claude/rules/hooks.md', type: 'Project', content: 'Hooks exit 0.' } },
    },
    { ...base, type: 'user', uuid: 'u3', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>be brief</system-reminder>' }] } },
  ].map((l) => JSON.stringify(l));

  it('keeps CLAUDE.md, rules and memory, redacted, with the seq they apply from', () => {
    const { result, instructions } = withFullText(() => parseTranscript(lines, 's1'));
    expect(instructions.map((i) => i.source)).toEqual(['CLAUDE.md', 'memory', 'rules/hooks.md']);
    expect(instructions[0]?.text).toContain('Never push.');
    expect(instructions[0]?.text).not.toContain('sk-ant-api03');
    // The rule loaded after the second prompt applies from there, not from the start.
    const second = result.events.find((e) => e.turnType === 'user_prompt' && e.uuid === 'u2');
    expect(instructions[2]?.fromSeq).toBeGreaterThan(second?.seq ?? Infinity);
  });

  it('captures nothing outside judge mode, and emits no events for them', () => {
    const plain = parseTranscript(lines, 's1');
    expect(plain.events.filter((e) => e.turnType === 'user_prompt')).toHaveLength(2);
  });

  it('treats a reminder inside array content as the harness, not a prompt', () => {
    const { events } = parseTranscript(lines, 's1');
    const last = events.at(-1);
    expect(last?.turnType).toBe('local_command');
  });
});
