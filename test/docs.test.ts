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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leadSegments } from '../src/render.ts';
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

/**
 * Every document a reader might copy a command out of.
 *
 * Deliberately includes the site and `docs/`, because the first version of
 * this guard covered only `README.md` and therefore missed
 * `docs/surfaces.md:32` advertising `agentsensei init`, which does not exist.
 * `docs/archive/` is excluded: it is explicitly archival.
 */
function userFacingDocs(): string[] {
  const out = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'];
  const walkSite = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkSite(full);
      else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) out.push(full);
    }
  };
  walkSite('site/src/content/docs');
  return out.filter((f) => existsSync(f));
}

/**
 * Those, plus the engineering docs under `docs/`.
 *
 * Used where the rule applies to anything a reader might run — an `npm run`
 * that no longer exists is a dead end wherever it appears. The command guard
 * deliberately does *not* use this wider set: `docs/surfaces.md` designs a
 * command surface, so naming `agentsensei trends` there is the subject matter,
 * not a false promise. `docs/archive/` is excluded throughout; it is
 * explicitly archival.
 */
function allDocs(): string[] {
  const out = userFacingDocs();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'archive' && entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
        out.push(full);
      }
    }
  };
  walk('docs');
  return out.filter((f) => existsSync(f));
}

describe('every `npm run` in the docs is a real script', () => {
  it('names no script package.json does not define', () => {
    // The docs reference `measure`, `gold`, `judge:control`, `verify:corpus`
    // and `cli`. A renamed script silently turns each mention into a dead end
    // for whoever follows it.
    const defined = new Set(Object.keys(
      JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>,
    ));
    const bad = new Set<string>();
    for (const file of allDocs()) {
      for (const m of readFileSync(file, 'utf8').matchAll(/npm run ([a-z][a-z:-]*)/g)) {
        const name = m[1] as string;
        if (!defined.has(name)) bad.add(`${name} (${file})`);
      }
    }
    expect([...bad], `docs reference npm scripts that do not exist`).toEqual([]);
  });
});

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
    // README-only was too narrow: `docs/surfaces.md:32` advertised
    // `agentsensei init` and the guard never saw it. Every page a reader might
    // copy a command out of is now in scope.
    const text = userFacingDocs()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const claimed = new Set(
      [...text.matchAll(/(?:agentsensei|\/agentsensei:)[ \t]+([a-z][a-z-]*)/g)].map(
        (m) => m[1] as string,
      ),
    );
    // Words that follow "agentsensei" in prose rather than as a command.
    const prose = new Set(['is', 'does', 'reads', 'finds', 'runs', 'and', 'to', 'the', 'a', 'in', 'on', 'for', 'as', 'at', 'from', 'with', 'you', 'your', 'it', 'its', 'can', 'will', 'has', 'have', 'was', 'were', 'needs', 'copies', 'writes', 'never', 'only', 'also', 'how', 'what', 'why', 'generate-report', 'looks', 'pipeline', 'itself']);
    const missing = [...claimed].filter((c) => !dispatch.has(c) && !prose.has(c));
    expect(missing, `docs advertise commands the CLI does not have: ${missing.join(', ')}`).toEqual([]);
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

describe('the plugin is the only front door', () => {
  // This guard used to require that an `npm install -g agentsensei` shown in
  // the docs be marked "not published yet". It now forbids it outright.
  //
  // The entry point is `/plugin install`. Nobody installs an analyzer for
  // Claude Code from npm, and `package.json` is `private: true` so the command
  // would fail anyway. The CLI still exists — it is what the plugin's hooks
  // and slash commands invoke — it is simply never typed by a human.
  it('tells nobody to install from npm', () => {
    for (const file of userFacingDocs()) {
      const text = readFileSync(file, 'utf8');
      // Contributing legitimately explains the from-source path.
      if (/contribut/i.test(file)) continue;
      expect(
        text,
        `${file} still sends a user to npm; the plugin is the install`,
      ).not.toMatch(/npm i(?:nstall)? -g agentsensei/);
    }
  });

  it('cannot be published to npm by accident', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { private?: boolean };
    expect(pkg.private).toBe(true);
  });

  it('shows the slash commands, not the binary, in user-facing samples', () => {
    // A plugin user types `/agentsensei:insights`. `agentsensei insights` is what the
    // command file runs on their behalf, and showing it invites them to try a
    // binary that is not on their PATH.
    const readme = readFileSync('README.md', 'utf8');
    const intro = readme.slice(0, readme.indexOf('## Contributing'));
    expect(intro).toContain('/agentsensei:insights');
  });

  it('names a way to turn it off', () => {
    // The judge is on from installation, so the off switch has to be findable.
    // It is harness-native — nothing of ours to build.
    expect(readFileSync('README.md', 'utf8')).toContain('/plugin disable agentsensei');
  });

  it('no user-facing surface still calls the judge opt-in', () => {
    // These were all written while the judge was off by default, and the
    // guards in place only covered the pitch string and the README intro —
    // so `SECURITY.md`, `CHANGELOG.md`, the site and the CLI's own `--help`
    // all kept saying "off by default" after it shipped on.
    //
    // A page may still *quote* the retired claim to say it is retired, and may
    // describe a competitor's opt-in cloud sync, so this looks for the claim
    // being made about us in the present tense.
    const CLAIMS = [
      /judge is \*\*off by default\*\*/i,
      /the opt-in model pass/i,
      /judge --enable/,
    ];
    const files = [...userFacingDocs(), 'SECURITY.md', 'CHANGELOG.md', 'src/cli.ts'];
    for (const file of files) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const claim of CLAIMS) {
        expect(text, `${file} still describes the judge as opt-in`).not.toMatch(claim);
      }
    }
  });

  it('shows plugin users the slash commands, not the binary', () => {
    // `agentsensei insights` is not on a plugin user's PATH — the CLI is what the
    // command file runs on their behalf. Contribute legitimately shows it.
    for (const file of userFacingDocs()) {
      if (/contribut/i.test(file)) continue;
      expect(
        readFileSync(file, 'utf8'),
        `${file} tells a user to run the binary directly`,
      ).not.toMatch(/^\s*agentsensei (now|fix|report|scan|standing|judge)\b/m);
    }
  });

  it('no doc states a test count, which rots on every commit', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/\b\d{3,} tests\b/);
    }
  });
});

describe('documented output samples match the shape the code produces', () => {
  // The full Tier-0 mechanism — regenerating every sample from a live run —
  // is not built. This is the cheap part of it, and it catches the failure
  // that actually matters.
  //
  // Numbers in a sample drift harmlessly: they illustrate one machine, and a
  // reader understands that. What makes a sample worthless is *shape* drift —
  // a renamed label, a dropped column, a changed unit — because then the
  // sample describes a tool that no longer exists, which is how every README
  // block in this project came to be fiction.
  //
  // So: run the real command, normalise every digit away, and require each
  // documented line to match a line the code can still produce.
  const shape = (line: string): string =>
    line.replace(/\d[\d,.]*/g, 'N').replace(/[ \t]+/g, ' ').trim();

  it('every documented lead line is one the code can produce', () => {
    // The lead changed twice in one sitting, and both times the README, the
    // site index and `what-it-is.md` kept the old wording — including an
    // overclaim the code had already been fixed to avoid. The `SESSION COST`
    // guard below did not cover these blocks because they contain only the
    // lead.
    //
    // Generated from `leadSegments` rather than hard-coded, so the shapes
    // cannot drift from the function that writes them.
    const canonical = new Set(
      [
        { ruleCount: 4, judgedCount: 19, total: 23, wasted: 11_000, editCount: 2460 },
        { ruleCount: 4, judgedCount: 0, total: 4, wasted: 11_000, editCount: 2460 },
        { ruleCount: 0, judgedCount: 19, total: 19, wasted: 0, editCount: 2460 },
        { ruleCount: 4, judgedCount: 19, total: 23, wasted: 0, editCount: 2460 },
        { ruleCount: 0, judgedCount: 0, total: 0, wasted: 0, editCount: 2460 },
      ].map((f) => {
        const seg = leadSegments(f);
        return shape(`${seg.figure ?? ''}${seg.rest}`);
      }),
    );

    // Any documented line that looks like a lead must be one of them.
    const looksLikeLead = /^\s*(?:[\d,]+\+? tokens |[\d,]+ findings?\b|no findings across)/;
    for (const file of [...userFacingDocs(), 'README.md']) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!looksLikeLead.test(line)) continue;
        // Prose mentions of a figure are not output; only indented code is.
        if (!line.startsWith('  ')) continue;
        expect(
          canonical,
          `${file} shows a lead line the code cannot produce:\n  ${line.trim()}`,
        ).toContain(shape(line));
      }
    }
  });

  it('every label in a documented `now` sample is one the renderer emits', () => {
    // An earlier version of this ran `now` and compared the output. It was
    // **flaky by construction**: the reference was the live session on the
    // machine running the suite, which grows while the suite runs, so a
    // sample could pass and fail minutes apart. A guard that fails at random
    // teaches people to ignore it.
    //
    // The deterministic question is narrower and is the one that matters: do
    // the section labels in the docs still exist in the renderer? That catches
    // the drift this guard was written for — a renamed or deleted heading —
    // without depending on anybody's session. The lead line, which is what
    // actually moved, has its own generated check above.
    const renderer = readFileSync('src/render.ts', 'utf8');

    for (const file of ['README.md', 'site/src/content/docs/start/first-finding.md']) {
      const doc = readFileSync(file, 'utf8');
      const fences = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string);
      const block = fences.find((f) => f.includes('SESSION COST'));
      if (block === undefined) continue;

      // ALL-CAPS lines are the renderer's section headings.
      const labels = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Z][A-Z ]{3,}$/.test(l));

      expect(labels.length, `${file} has a \`now\` sample with no section labels`).toBeGreaterThan(0);
      for (const label of labels) {
        expect(
          renderer,
          `${file} shows a \`${label}\` heading that src/render.ts no longer emits`,
        ).toContain(label);
      }
    }
  });

  it('`judge --status` still prints the lines the docs show', () => {
    const archive = mkdtempSync(join(tmpdir(), 'as-docshape-'));
    const env = { ...process.env, AGENTSENSEI_ARCHIVE: archive, NO_COLOR: '1' };
    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], {
        encoding: 'utf8',
        env,
      });
    // The documented sample is the *enabled* branch — a disabled judge prints
    // "nothing will run until you enable it" instead, which is a different
    // shape and would make this compare the wrong thing.
    run('judge', '--enable', '--apply');
    const real = run('judge', '--status');
    const produced = new Set(real.split('\n').map(shape).filter((l) => l !== ''));

    // Wherever a page shows this sample. `judge --status` is a CLI command and
    // the CLI is no longer a user-facing surface, so no page may show it at
    // all — that is a correct state, not a missing sample.
    const pages = userFacingDocs().filter((f) => f.startsWith('site/'));
    const doc = pages.map((f) => readFileSync(f, 'utf8')).join('\n');
    const block = /judged {2,}[^\n]*\n(?:[^\n]*\n)*?[^\n]*spent[^\n]*/.exec(doc)?.[0] ?? '';
    if (block === '') return;

    const drifted = block
      .split('\n')
      .map(shape)
      .filter((l) => l !== '')
      // `spent` only appears once calls have been made, and a scratch archive
      // has none — so its absence here is correct, not drift.
      .filter((l) => !l.startsWith('spent') && !l.startsWith('tokens, not dollars'))
      .filter((l) => !produced.has(l));

    expect(
      drifted,
      `the judge page shows lines \`judge --status\` no longer prints:\n  ${drifted.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('one pitch, not five', () => {
  // There were five different one-line descriptions of this tool — README,
  // package.json, plugin.json, the CLI's USAGE header and the site all phrased
  // the promise differently, and `.claude-plugin/marketplace.json` had none at
  // all, which is the string a user reads in the plugin picker before
  // installing.
  //
  // The point is not that one wording is better. It is that a reader who sees
  // the tool in three places should recognise it as one thing.
  // The last clause changed when the judge became on-by-default: "on your own
  // machine" stopped being true the moment redacted excerpts started going to
  // the model. The replacement is the stronger claim — no new trust
  // relationship — and it is what the egress page now argues.
  const PITCH =
    "See what your coding agent's mistakes cost you — in tokens, with the exact turns, using the AI you already pay for.";

  it('is identical in every manifest', () => {
    const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    expect(json('package.json')['description']).toBe(PITCH);
    expect(json('.claude-plugin/plugin.json')['description']).toBe(PITCH);
    const market = json('.claude-plugin/marketplace.json') as {
      plugins: { description?: string }[];
    };
    expect(market.plugins[0]?.description).toBe(PITCH);
  });

  it('is what the site leads with', () => {
    const index = readFileSync('site/src/content/docs/index.mdx', 'utf8');
    expect(index).toContain(PITCH);
    expect(readFileSync('site/astro.config.mjs', 'utf8')).toContain(PITCH);
  });

  it('agrees with the README hero', () => {
    // The README may break the line, so compare without whitespace.
    const flat = readFileSync('README.md', 'utf8').replace(/\s+/g, ' ');
    expect(flat).toContain(PITCH.replace(/\s+/g, ' '));
  });

  it('does not leave the retired tagline behind anywhere', () => {
    for (const file of userFacingDocs()) {
      expect(
        readFileSync(file, 'utf8'),
        `${file} still carries the old tagline`,
      ).not.toContain('Find the turns where you and your coding agent wasted effort');
      expect(
        readFileSync(file, 'utf8'),
        `${file} still says the work happens only on your own machine`,
      ).not.toContain('with the exact turns, on your own machine');
    }
  });

  it('keeps the package and plugin versions in step', () => {
    // package.json said 0.0.0 while plugin.json said 0.1.0.
    const v = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
    expect(v('package.json')).toBe(v('.claude-plugin/plugin.json'));
  });
});

describe('the diagrams are committed and current', () => {
  // Diagrams are rendered once by `npm run diagrams` and both files are
  // committed: a reader downloads ~5 KB of SVG and no JavaScript, and the
  // diagram is there when the page is. Client-side mermaid was measured at
  // **1,536 KB gzipped** against a site that ships 192 KB of JS in total.
  //
  // The cost of that choice is a step someone can forget, which is what these
  // guard.
  const dir = 'site/src/diagrams';

  it('every source has a rendered output', () => {
    const sources = readdirSync(dir).filter((f) => f.endsWith('.mmd'));
    expect(sources.length, 'no diagram sources found').toBeGreaterThan(0);
    for (const src of sources) {
      const svg = join(dir, src.replace(/\.mmd$/, '.svg'));
      expect(existsSync(svg), `${src} has no committed .svg — run \`npm run diagrams\``).toBe(true);
    }
  });

  it('no rendered output is older than its source', () => {
    // A stale picture is worse than no picture: it describes a system that
    // changed, with all the authority of a diagram.
    for (const src of readdirSync(dir).filter((f) => f.endsWith('.mmd'))) {
      const svg = join(dir, src.replace(/\.mmd$/, '.svg'));
      if (!existsSync(svg)) continue;
      expect(
        statSync(svg).mtimeMs,
        `${src} is newer than its .svg — run \`npm run diagrams\``,
      ).toBeGreaterThanOrEqual(statSync(join(dir, src)).mtimeMs);
    }
  });

  it('ships no embedded fonts', () => {
    // `mmdc` embeds a webfont as base64 by default — 161 KB inside a 190 KB
    // style block, for a five-node flowchart. Passing any config file avoids
    // it; `scripts/diagrams.mjs` strips it as well, as a safety net.
    for (const svg of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
      const text = readFileSync(join(dir, svg), 'utf8');
      expect(text, `${svg} has an embedded font`).not.toContain('@font-face');
      expect(text, `${svg} has a base64 blob`).not.toContain('base64');
      expect(text.length, `${svg} is over 50 KB`).toBeLessThan(50_000);
    }
  });
});

describe('the plugin command files are not a stale copy', () => {
  // `commands/*.md` and the bodies in `install.ts` are two copies of the same
  // thing, and the copies have now drifted twice: the `:now` rename updated
  // one, and `--open` was only ever added to the other — so
  // `/agentsensei:report` wrote a file and handed back a path to copy, while
  // the installed command opened it.
  //
  // `install.ts` is being deleted (D64), which makes these files the only
  // copy. These assertions are what survives that deletion.
  const body = (name: string): string => readFileSync(`commands/${name}.md`, 'utf8');

  it('report opens what it just wrote', () => {
    expect(body('report')).toContain('--html --open');
  });

  it('every command invokes a subcommand the CLI dispatches', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    for (const name of ['insights', 'report', 'fix']) {
      const m = /cli\.ts"\s+(\w[\w-]*)/.exec(body(name));
      expect(m, `${name}.md invokes nothing`).not.toBeNull();
      const sub = m?.[1] ?? '';
      expect(cli, `${name}.md invokes \`${sub}\`, which has no case`).toContain(`case '${sub}'`);
    }
  });

  it('runs through CLAUDE_PLUGIN_ROOT, never a hardcoded checkout', () => {
    // An absolute path baked at install time is what made the old command
    // files break when the checkout moved.
    for (const name of ['insights', 'report', 'fix']) {
      expect(body(name)).toContain('${CLAUDE_PLUGIN_ROOT}');
    }
  });
});
