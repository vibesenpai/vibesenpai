#!/usr/bin/env node
/**
 * Render every `.mmd` in `src/diagrams/` to an `.svg` beside it.
 *
 * ── Why committed SVGs rather than a mermaid integration ──────────────────
 *
 * The obvious route is `astro-mermaid`, which renders in the browser. Measured
 * before choosing: mermaid's browser bundle is **1,536 KB gzipped**, against a
 * site that ships 192 KB of JavaScript in total. That is an eightfold increase
 * so a reader can watch diagrams appear after the page does — and nothing at
 * all for a reader with JavaScript off.
 *
 * Build-time rendering via `rehype-mermaid` avoids that but needs Playwright in
 * CI, and is reported not to work under Astro without a workaround.
 *
 * So: render once, here, commit both files. A reader downloads ~6 KB of SVG and
 * no JavaScript, the diagram is there when the page is, and a change to a
 * diagram shows up in review as a diff rather than as a new binary.
 *
 * ── The font problem, and what actually fixes it ──────────────────────────
 *
 * By default `mmdc` embeds its own webfont as base64 inside every SVG — four
 * `@font-face` rules, 161 KB, inside a 190 KB `<style>` block, for a five-node
 * flowchart. Measured on one diagram:
 *
 *     no -c flag          205,459 bytes   4 @font-face
 *     -b transparent      205,465 bytes   4 @font-face   (no effect)
 *     -c <any config>      20,072 bytes   0 @font-face
 *
 * **Passing a config file is what avoids it**, not the stripping below. The
 * default theme bundles the font; naming a theme explicitly does not. That was
 * worth measuring rather than assuming, because the obvious reading — that the
 * post-processing is doing the work — is wrong.
 *
 * `lean()` stays as a safety net. It costs nothing on output that is already
 * clean, and if a future mermaid embeds fonts under a named theme too, the
 * committed SVGs do not quietly grow by 180 KB each.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS = join(HERE, '..', 'src', 'diagrams');

/** The page's own stack, so a diagram's labels match the prose around them. */
const FONT = 'ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif';

function lean(svg) {
  return (
    svg
      // The embedded webfont: the whole reason the file is 200 KB.
      .replace(/@font-face\s*\{[^}]*\}/g, '')
      .replace(/font-family:\s*"?[Oo]pen\s?[Ss]ans"?[^;"}]*/g, `font-family:${FONT}`)
      // `mmdc` leaves the blank lines behind where the rules were.
      .replace(/\n\s*\n/g, '\n')
      .trim() + '\n'
  );
}

const sources = readdirSync(DIAGRAMS).filter((f) => f.endsWith('.mmd')).sort();
if (sources.length === 0) {
  console.error('no .mmd files in src/diagrams');
  process.exit(1);
}

// A transparent background: the page supplies its own, and a baked-in white
// rectangle is exactly what makes a diagram look wrong in dark mode.
const config = join(mkdtempSync(join(tmpdir(), 'mmdc-')), 'config.json');
// Dark panels with light text and slate lines read on both the site's dark and light pages.
writeFileSync(config, JSON.stringify({
  theme: 'base',
  flowchart: { curve: 'basis' },
  themeVariables: {
    fontFamily: FONT,
    primaryColor: '#161b22',
    primaryTextColor: '#e6edf3',
    primaryBorderColor: '#3a4a5e',
    secondaryColor: '#1f2a44',
    tertiaryColor: '#131922',
    lineColor: '#8fa3b8',
    textColor: '#8fa3b8',
    edgeLabelBackground: '#1f2a44',
    clusterBkg: '#131922',
    clusterBorder: '#3a4a5e',
  },
}));

let failed = 0;
for (const file of sources) {
  const from = join(DIAGRAMS, file);
  const to = from.replace(/\.mmd$/, '.svg');
  try {
    execFileSync(
      'npx',
      ['mmdc', '-i', from, '-o', to, '-b', 'transparent', '-c', config, '--quiet'],
      { cwd: join(HERE, '..'), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const before = readFileSync(to, 'utf8');
    const after = lean(before);
    writeFileSync(to, after);
    const saved = before.length - after.length;
    const note = saved > 0 ? `  (stripped ${(saved / 1024).toFixed(0)} KB of embedded font)` : '';
    console.log(
      `  ${file.padEnd(22)} → ${(after.length / 1024).toFixed(1).padStart(6)} KB${note}`,
    );
  } catch (err) {
    failed += 1;
    console.error(`  ${file}: FAILED\n${String(err.stderr ?? err).slice(0, 400)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
