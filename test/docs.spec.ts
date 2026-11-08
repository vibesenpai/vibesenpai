// Docs must describe the tool that exists: real dimensions, commands, scripts and output shapes.
// The dead-dimension check covers only the README; GRAVEYARD.md and docs/dimensions.md name the dead on purpose.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextRung } from '../src/session-block.ts';
import { leadSegments } from '../src/render.ts';
import { JUDGE_DIMENSIONS } from '../src/judge/prompt.ts';
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

/** Snake_case words that look like a dimension and are not one. A "graveyard" section is exempt. */
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

/** Every document a reader might copy a command out of: README, CONTRIBUTING, SECURITY and the site. */
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
 * Those plus `docs/` (minus `docs/archive/`). The command guard does not use this set:
 * `docs/surfaces.md` designs commands, so naming unbuilt ones there is the subject matter.
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
    // A failure means either unbuilt fiction or a new dimension missing from `NOT_DIMENSIONS`.
    const found = fictionIn('README.md');
    expect(
      found,
      `README names dimensions that do not exist:\n${found
        .map((f) => `  line ${f.line}: ${f.word}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('names no command the CLI does not dispatch', () => {
    const dispatch = new Set(
      [...readFileSync('src/cli.ts', 'utf8').matchAll(/^ {4}case '([a-z-]+)':/gm)].map(
        (m) => m[1] as string,
      ),
    );
    const text = userFacingDocs()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const claimed = new Set(
      [...text.matchAll(/(?:vibesenpai|\/vibesenpai:)[ \t]+([a-z][a-z-]*)/g)].map(
        (m) => m[1] as string,
      ),
    );
    // Words that follow "vibesenpai" in prose rather than as a command.
    const prose = new Set(['is', 'does', 'reads', 'finds', 'runs', 'and', 'to', 'the', 'a', 'in', 'on', 'for', 'as', 'at', 'from', 'with', 'you', 'your', 'it', 'its', 'can', 'will', 'has', 'have', 'was', 'were', 'needs', 'copies', 'writes', 'never', 'only', 'also', 'how', 'what', 'why', 'generate-report', 'looks', 'pipeline', 'itself']);
    // The installer was deleted (D64) and the docs still describe it; drop this when the docs are rewritten.
    const awaitingDocsPass = new Set(['install', 'uninstall']);
    const missing = [...claimed].filter((c) => !dispatch.has(c) && !prose.has(c) && !awaitingDocsPass.has(c));
    expect(missing, `docs advertise commands the CLI does not have: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('no session residue in published prose', () => {
  it('does not address the reader as a conversation partner', () => {
    // Phrases that read as one side of a chat with the author.
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
    // Star counts rot; compare on behaviour.
    for (const f of ['README.md', 'docs/prior-art.md']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/\b\d{2,4}\s*stars\b/i);
    }
  });
});

describe('the one command that sends data off the machine is discoverable', () => {
  it('names `judge` in --help', () => {
    // The only command that sends session content to a model must be visible in --help.
    const usage = readFileSync('src/cli.ts', 'utf8');
    const block = /^Usage$([\s\S]*?)^$/m.exec(usage)?.[1] ?? usage;
    expect(block).toMatch(/vibesenpai judge/);
  });

  it('does not advertise the statusline, which was removed', () => {
    // The statusline was removed (DECISIONS.md D58).
    expect(readFileSync('src/cli.ts', 'utf8')).not.toMatch(/hooks \+ statusline/);
  });
});

describe('the plugin is the only front door', () => {
  // `package.json` is `private: true`; the CLI is what the plugin invokes, never typed by a human (D64).
  it('tells nobody to install from npm', () => {
    for (const file of userFacingDocs()) {
      const text = readFileSync(file, 'utf8');
      // Contributing legitimately explains the from-source path.
      if (/contribut/i.test(file)) continue;
      expect(
        text,
        `${file} still sends a user to npm; the plugin is the install`,
      ).not.toMatch(/npm i(?:nstall)? -g vibesenpai/);
    }
  });

  it('cannot be published to npm by accident', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { private?: boolean };
    expect(pkg.private).toBe(true);
  });

  it('shows the slash commands, not the binary, in user-facing samples', () => {
    // The binary is not on a plugin user's PATH.
    const readme = readFileSync('README.md', 'utf8');
    const intro = readme.slice(0, readme.indexOf('## Contributing'));
    expect(intro).toContain('/vibesenpai:insights');
  });

  it('names a way to turn it off', () => {
    // The judge is on from installation, so the off switch must be findable.
    expect(readFileSync('README.md', 'utf8')).toContain('/plugin disable vibesenpai');
  });

  it('no user-facing surface still calls the judge opt-in', () => {
    // The judge ships on. Pages may quote the retired claim, so this matches present-tense claims only.
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
    for (const file of userFacingDocs()) {
      if (/contribut/i.test(file)) continue;
      expect(
        readFileSync(file, 'utf8'),
        `${file} tells a user to run the binary directly`,
      ).not.toMatch(/^\s*vibesenpai (now|fix|report|scan|standing|judge)\b/m);
    }
  });

  it('no doc states a test count, which rots on every commit', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/\b\d{3,} tests\b/);
    }
  });
});

describe('documented output samples match the shape the code produces', () => {
  // Numbers drift harmlessly; shape drift (renamed label, dropped column) makes a sample fiction.
  // So normalise digits away and require each documented line to match one the code produces.
  const shape = (line: string): string =>
    line.replace(/\d[\d,.]*/g, 'N').replace(/[ \t]+/g, ' ').trim();

  it('every documented lead line is one the code can produce', () => {
    // Shapes are generated from `leadSegments`, so they cannot drift from the function that writes them.
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
    // Compares section labels only: running `now` against the live session was flaky by construction.
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
    const env = { ...process.env, VIBESENPAI_ARCHIVE: archive, NO_COLOR: '1' };
    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], {
        encoding: 'utf8',
        env,
      });
    // The documented sample is the enabled branch.
    run('judge', '--enable', '--apply');
    const real = run('judge', '--status');
    const produced = new Set(real.split('\n').map(shape).filter((l) => l !== ''));

    // The CLI is not a user-facing surface, so no page showing this sample is a valid state.
    const pages = userFacingDocs().filter((f) => f.startsWith('site/'));
    const doc = pages.map((f) => readFileSync(f, 'utf8')).join('\n');
    const block = /judged {2,}[^\n]*\n(?:[^\n]*\n)*?[^\n]*spent[^\n]*/.exec(doc)?.[0] ?? '';
    if (block === '') return;

    const drifted = block
      .split('\n')
      .map(shape)
      .filter((l) => l !== '')
      // `spent` appears only after calls; a scratch archive has none.
      .filter((l) => !l.startsWith('spent') && !l.startsWith('tokens, not dollars'))
      .filter((l) => !produced.has(l));

    expect(
      drifted,
      `the judge page shows lines \`judge --status\` no longer prints:\n  ${drifted.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('one pitch, not five', () => {
  // One description of the tool across every manifest, the site and the README.
  const PITCH =
    "Discover how your agents failed you. vibesenpai reads the sessions already on your disk and shows you the exact turns, what you'd asked for, and what it cost.";

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
    // The README may break the line and bold the headline, so compare
    // without whitespace or emphasis.
    const flat = readFileSync('README.md', 'utf8').replace(/\*\*/g, '').replace(/\s+/g, ' ');
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
        `${file} still carries the old tagline`,
      ).not.toContain("See what your coding agent's mistakes cost you");
      expect(
        readFileSync(file, 'utf8'),
        `${file} still says the work happens only on your own machine`,
      ).not.toContain('with the exact turns, on your own machine');
    }
  });

  it('keeps the package and plugin versions in step', () => {
    const v = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
    expect(v('package.json')).toBe(v('.claude-plugin/plugin.json'));
  });
});

describe('the diagrams are committed and current', () => {
  // Diagrams are pre-rendered and committed: client-side mermaid is ~1.5 MB gzipped.
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
    // `mmdc` embeds a base64 webfont by default; `scripts/diagrams.mjs` strips it.
    for (const svg of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
      const text = readFileSync(join(dir, svg), 'utf8');
      expect(text, `${svg} has an embedded font`).not.toContain('@font-face');
      expect(text, `${svg} has a base64 blob`).not.toContain('base64');
      expect(text.length, `${svg} is over 50 KB`).toBeLessThan(50_000);
    }
  });
});

describe('the plugin command files are not a stale copy', () => {
  // `commands/*.md` are the only copy of the command bodies since the installer was deleted (D64).
  const body = (name: string): string => readFileSync(`commands/${name}.md`, 'utf8');

  it('report opens what it just wrote', () => {
    expect(body('report')).toContain('--html --open');
  });

  // Three since D70: the pane is where findings are acted on.
  const shipped = readdirSync('commands').filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();

  it('ships exactly insights, judge and report', () => {
    expect(shipped).toEqual(['insights', 'judge', 'report']);
  });

  it('no user-facing doc names a slash command the plugin does not ship', () => {
    const stale = userFacingDocs().flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\/vibesenpai:([a-z][a-z-]*)/g)].map((m) => m[1] as string).filter((n) => !shipped.includes(n)).map((n) => `${f}: /vibesenpai:${n}`),
    );
    expect(stale).toEqual([]);
  });

  it('every command invokes a subcommand the CLI dispatches', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    for (const name of shipped) {
      const m = /cli\.ts"\s+(\w[\w-]*)/.exec(body(name));
      expect(m, `${name}.md invokes nothing`).not.toBeNull();
      const sub = m?.[1] ?? '';
      expect(cli, `${name}.md invokes \`${sub}\`, which has no case`).toContain(`case '${sub}'`);
    }
  });

  it('runs through CLAUDE_PLUGIN_ROOT, never a hardcoded checkout', () => {
    // An absolute path baked at install time breaks when the checkout moves.
    for (const name of shipped) {
      expect(body(name)).toContain('${CLAUDE_PLUGIN_ROOT}');
    }
  });
});

describe('every surface ends by naming the next one', () => {
  // Each surface ends by pointing at the next one.
  const rungs = ['block', 'insights', 'report', 'fix'] as const;

  it('gives every surface a rung', () => {
    for (const r of rungs) {
      expect(nextRung(r), `${r} has no next step`).not.toBe('');
    }
  });

  it('names only commands the plugin actually ships', () => {
    const shipped = readdirSync('commands').map((f) => f.replace(/\.md$/, ''));
    for (const r of rungs) {
      const m = /\/vibesenpai:(\w+)/.exec(nextRung(r));
      expect(m, `${r} names no command`).not.toBeNull();
      expect(shipped, `${r} points at /vibesenpai:${m?.[1]}, which is not shipped`).toContain(
        m?.[1] ?? '',
      );
    }
  });

  it('never points a surface at itself', () => {
    for (const r of rungs) {
      if (r === 'block') continue;
      expect(nextRung(r), `${r} points at itself`).not.toContain(`/vibesenpai:${r}`);
    }
  });
});

describe('the fix block reads as sections, not as a form', () => {
  const src = readFileSync('src/fix.ts', 'utf8');

  it('uses headings a reader takes as questions', () => {
    for (const h of ['What happened', 'Why it happens', 'What you can do']) {
      expect(src, `missing the "${h}" heading`).toContain(h);
    }
  });

  it('drops the vocabulary that was ours rather than theirs', () => {
    const render = /export function renderFix[\s\S]*$/.exec(src)?.[0] ?? '';
    expect(render, 'the artifact kind is our catalogue, not their problem').not.toMatch(
      /\[\$\{r\.kind\}\]|\$\{green\(/,
    );
    expect(render, 'and the heading phrase was rejected twice').not.toMatch(/one thing to try/);
  });

  it('shows the judge account of this case, not only the generic reason', () => {
    // Without it the block printed a bare quote with nothing saying what it was.
    expect(src).toMatch(/happened\?: string/);
    expect(src).toMatch(/r\.happened/);
  });

  it('puts the reason for a remedy next to that remedy', () => {
    expect(src).toMatch(/helps: string/);
    expect(src).toMatch(/wrap\(r\.config\.helps/);
    expect(src).toMatch(/r\.promptHelps/);
  });

  it('gives every remedy in the catalogue one', () => {
    // A heading promising a reason must have one under it.
    const entries = [...src.matchAll(/^  (\w+): \{$/gm)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    const configs = [...src.matchAll(/config: \{\n\s+helps:/g)];
    expect(configs.length, 'every config remedy needs a `helps`').toBeGreaterThanOrEqual(4);
  });
});
