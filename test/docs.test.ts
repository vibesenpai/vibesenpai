/**
 * The README is the sixty-second document, and it was fiction.
 *
 * ── What this exists to stop ───────────────────────────────────────────────
 *
 * Every output sample in the README was a mockup, and the dimensions in them
 * either never existed or had been **rejected by measurement**. `file_churn`
 * was the second line of the headline report while `GRAVEYARD.md` recorded it
 * as rejected; `convergent_iteration` and `context_saturation` had zero hits in
 * `src/`; `constraint_decay` was a label with no detector.
 *
 * A stranger cannot tell a mockup from a real capability, so on launch day the
 * most quotable thing about this project would have been that its headline
 * report describes detectors it does not have.
 *
 * ── Why only the README ───────────────────────────────────────────────────
 *
 * Naming a dead dimension is `GRAVEYARD.md`'s entire job, and
 * `docs/dimensions.md` has a `## Deliberately not built` section that is one of
 * the most useful things in the repo. Those must stay free to name the dead.
 *
 * The README is different: it is read by someone deciding whether the tool
 * works, and it has no section that could make a dead name correct. So the rule
 * is scoped rather than global, and the scope is the risk.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JUDGE_DIMENSIONS } from '../src/judge.ts';
import { detectorsFor } from '../src/detect/index.ts';

/** Snake_case identifiers that are not dimensions and never were. */
const NOT_DIMENSIONS = new Set([
  // TurnType, src/types.ts
  'user_prompt', 'assistant_msg', 'tool_use', 'tool_result', 'queue_operation', 'local_command',
  // Event fields and tool-output shapes
  'tool_use_error', 'output_tokens', 'input_tokens', 'cache_creation', 'cache_read',
  'session_id', 'session_sha', 'last_assistant_message', 'transcript_path', 'stop_hook_active',
  'preTokens_postTokens',
  // Harness and config identifiers
  'alignment_goal', 'other_descriptor', 'permissionDecision_deny', 'load_reason',
  'total_cost_usd', 'is_error', 'settings_json',
]);

const realDimensions = (): Set<string> =>
  new Set([...JUDGE_DIMENSIONS, ...detectorsFor('all').map((d) => d.dimension)]);

/**
 * Snake_case words that look like a dimension and are not one.
 *
 * **The graveyard section is exempt**, because naming the dead is the point of
 * it. The rule being enforced is "do not present a dimension the tool does not
 * have as a capability" — and a section headed "The graveyard" does the
 * opposite of that, explicitly. Without the exemption the README could not tell
 * you what was deleted, which is one of the more useful things it says.
 */
function fictionIn(path: string): { word: string; line: number }[] {
  const real = realDimensions();
  const out: { word: string; line: number }[] = [];
  let inGraveyard = false;
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (/^##\s/.test(text)) inGraveyard = /graveyard/i.test(text);
      if (inGraveyard) return;
      for (const m of text.matchAll(/`?\b([a-z][a-z0-9]*_[a-z0-9_]+)\b`?/g)) {
        const word = m[1] as string;
        if (real.has(word) || NOT_DIMENSIONS.has(word)) continue;
        out.push({ word, line: i + 1 });
      }
    });
  return out;
}

describe('the README describes the tool that exists', () => {
  it('names no dimension the tool does not have', () => {
    // If this fails, either the README is describing something unbuilt, or a
    // real dimension was added without updating `NOT_DIMENSIONS`. Read the
    // failure before silencing it: the first case is the one that matters.
    const found = fictionIn('README.md');
    expect(
      found,
      `README names dimensions that do not exist:\n${found
        .map((f) => `  line ${f.line}: ${f.word}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('names no command the CLI does not dispatch', () => {
    // The README advertised `/agentsensei:claude-md`, `agentsensei init`,
    // `agentsensei models install`, `/agentsensei:why` and
    // `/agentsensei:setup-models`. None of them dispatch.
    const dispatch = new Set(
      [...readFileSync('src/cli.ts', 'utf8').matchAll(/^ {4}case '([a-z-]+)':/gm)].map(
        (m) => m[1] as string,
      ),
    );
    const readme = readFileSync('README.md', 'utf8');
    const claimed = new Set(
      [...readme.matchAll(/(?:agentsensei|\/agentsensei:)[ \t]+([a-z][a-z-]*)/g)].map(
        (m) => m[1] as string,
      ),
    );
    // Words that follow "agentsensei" in prose rather than as a command.
    const prose = new Set(['is', 'does', 'reads', 'finds', 'runs', 'and', 'to', 'the', 'a', 'in', 'on', 'for', 'as', 'at', 'from', 'with', 'you', 'your', 'it', 'its', 'can', 'will', 'has', 'have', 'was', 'were', 'needs', 'copies', 'writes', 'never', 'only', 'also', 'how', 'what', 'why', 'generate-report']);
    const missing = [...claimed].filter((c) => !dispatch.has(c) && !prose.has(c));
    expect(missing, `README advertises commands the CLI does not have: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('no session residue in published prose', () => {
  it('does not address the reader as a conversation partner', () => {
    // Seven passages read as one side of a chat: "the gap you spotted",
    // "aspirational an hour ago", "it needs a go-ahead before I do it",
    // "that was my own edit", "the bug I had missed". They are worse than a
    // TODO, because a TODO is addressed to nobody in particular.
    const files = ['README.md', 'PLAN.md', 'GRAVEYARD.md', 'docs/artifacts.md', 'docs/distribution.md'];
    const banned = [
      /\byou spotted\b/i,
      /\ban hour ago\b/i,
      /go-ahead before I\b/i,
      /\bmy own edit\b/i,
      /\bI had missed\b/i,
      /\bI had overweighted\b/i,
      /\bI had originally\b/i,
    ];
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          for (const re of banned) if (re.test(l)) hits.push(`${f}:${i + 1} — ${l.trim().slice(0, 70)}`);
        });
    }
    expect(hits, `session residue found:\n${hits.join('\n')}`).toEqual([]);
  });

  it('does not cite a competitor by star count', () => {
    // Star counts rot, and punching down at a named project reads badly in a
    // public README. Compare on behaviour or not at all.
    for (const f of ['README.md', 'docs/prior-art.md']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/\b\d{2,4}\s*stars\b/i);
    }
  });
});

describe('the one command that sends data off the machine is discoverable', () => {
  it('names `judge` in --help', () => {
    // `judge` was dispatched but absent from USAGE. The only command that sends
    // session content to a model was invisible to `--help`, which is the
    // opposite of how an opt-in should work.
    const usage = readFileSync('src/cli.ts', 'utf8');
    const block = /^Usage$([\s\S]*?)^$/m.exec(usage)?.[1] ?? usage;
    expect(block).toMatch(/agentsensei judge/);
  });

  it('does not advertise the statusline, which was removed', () => {
    // USAGE said `install  add the hooks + statusline`. The statusline was
    // built, worked, and was deliberately deleted (DECISIONS D58). Advertising
    // it invites someone to look for a feature that is gone.
    expect(readFileSync('src/cli.ts', 'utf8')).not.toMatch(/hooks \+ statusline/);
  });
});

describe('the docs do not promise an install that does not exist', () => {
  // The README's first quickstart line was `npm install -g agentsensei`, which
  // fails with E404 — the package is not published. That is the same class of
  // error as the fictional dimensions this file was written to catch: the
  // difference between "we built this" and "you can run this".
  //
  // This guard does not forbid documenting the published install. It requires
  // that wherever a doc shows one, the page also says it is not available yet.
  const UNPUBLISHED = [/npm i(?:nstall)? -g agentsensei/, /\/plugin install agentsensei/];

  for (const file of ['README.md', 'site/src/content/docs/start/install.md']) {
    it(`${file} marks the unpublished installs as unavailable`, () => {
      const text = readFileSync(file, 'utf8');
      const shown = UNPUBLISHED.filter((re) => re.test(text));
      if (shown.length === 0) return;
      // Any wording will do; what matters is that the page says so somewhere.
      expect(text).toMatch(/not published yet|not on npm|not yet reachable|once published/i);
    });
  }

  it('no doc states a test count, which rots on every commit', () => {
    // `README:252` said "519 tests" while the suite had 525. The count is not
    // the useful part of that line — "no network" is.
    for (const file of ['README.md', 'CONTRIBUTING.md']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/\b\d{3,} tests\b/);
    }
  });
});
