/**
 * The HTML report — a second renderer over the same data, not a second pipeline.
 *
 * Pure: `(ReportData) → string`. No filesystem, no clock, no config, so it is
 * testable without a transcript.
 *
 * ── Escaping is a security property here ───────────────────────────────────
 *
 * Paths, commands and refusal text come from somebody's transcript. A repo
 * containing a file named `<img src=x onerror=…>` would otherwise execute when
 * the report is opened — the report author's browser, running the analysed
 * project's content. Every interpolated value goes through `esc`, and the one
 * exception is written as a deliberate `raw()` call so it cannot happen by
 * accident.
 *
 * ── Nothing external, and nothing executable ───────────────────────────────
 *
 * Inline `<style>`; no `<link>`, no CDN, no webfont, no image, no script.
 * CLAUDE.md forbids network in the shipped analysis path, and the stronger
 * reason is that a report which fetches anything tells whoever answers that it
 * exists and when it was opened. A test asserts the absence by regex, because
 * one pasted URL would undo it silently.
 *
 * Collapsible sections are `<details>`, which the browser already does. There
 * is no JavaScript to block, to debug, or to be blamed for.
 *
 * ── No charts ──────────────────────────────────────────────────────────────
 *
 * The three cost figures sit on three price tiers — output, cache write, cache
 * read. One axis would assert a comparison that is false. The same reason the
 * terminal has no bars, and the project hands out no scores.
 */

import { approx } from './cost.ts';
import { describeCoverage, segmentByDepth } from './report.ts';
import { CORPUS, shortenPath } from './render.ts';
import type { FindingView, ReportData, SessionView } from './gather.ts';

/** The only way a value reaches the page. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markup this module authored itself, named so review can grep for it. */
function raw(markup: string): string {
  return markup;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** The footer time, in the reader's own timezone rather than UTC. */
function localStamp(isoTs: string): string {
  const t = new Date(isoTs);
  if (Number.isNaN(t.getTime())) return isoTs.slice(0, 16).replace('T', ' ');
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
    `${p(t.getHours())}:${p(t.getMinutes())}`
  );
}
const shortId = (id: string): string => id.slice(0, 8);

function human(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** `8d2h`, or undefined when either end is missing. */
function duration(from?: string, to?: string): string | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/**
 * Light and dark, both defined on tokens.
 *
 * The dark palette redefines only the variables, so nothing can end up with a
 * colour that exists in one theme and not the other. `color-scheme` is set so
 * scrollbars and form controls follow.
 */
const STYLE = `
:root{color-scheme:light;
--bg:#fbfbfa;--panel:#fff;--line:#e4e4e1;--fg:#1c1c1a;--mute:#6b6b66;
--accent:#1f5f8b;--bad:#9b2c2c;--good:#2f6d3f;--mark:#8a6d1f;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--bg:#15171a;--panel:#1b1e22;--line:#2b2f35;--fg:#e8e8e6;--mute:#9a9a94;
--accent:#7fb3d5;--bad:#e08585;--good:#8fcba3;--mark:#d9b96a}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem 4rem;background:var(--bg);color:var(--fg);
font:14px/1.6 var(--mono)}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.15rem;font-weight:600;margin:0 0 .25rem;letter-spacing:-.01em}
h2{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;
color:var(--mute);margin:2.5rem 0 .75rem}
.sub{color:var(--mute);margin:0 0 2rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;
padding:1rem 1.15rem;margin:0 0 .6rem}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:500;color:var(--mute);font-size:.78rem;
padding:0 .7rem .4rem 0;border-bottom:1px solid var(--line)}
td{padding:.3rem .7rem .3rem 0;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}
.fig{font-weight:600}
.mute{color:var(--mute)}
.bad{color:var(--bad)}
.good{color:var(--good)}
.subj{color:var(--accent);word-break:break-all}
.dim-name{font-weight:600}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;
padding:.05rem .5rem;font-size:.72rem;color:var(--mute);margin-left:.4rem}
details{background:var(--panel);border:1px solid var(--line);border-radius:6px;
margin:0 0 .5rem}
summary{cursor:pointer;padding:.7rem 1.15rem;display:flex;flex-wrap:wrap;
gap:.3rem 1rem;align-items:baseline}
summary::marker{color:var(--mute)}
details>div{padding:0 1.15rem 1.15rem}
.finding{border-top:1px solid var(--line);padding-top:1rem;margin-top:1rem}
.finding:first-child{border-top:0;margin-top:0}
.scroll{overflow-x:auto}
.note{color:var(--mute);font-size:.82rem}
footer{color:var(--mute);font-size:.78rem;margin-top:3rem;
border-top:1px solid var(--line);padding-top:1rem}
@media(max-width:34rem){body{padding:1rem .75rem 3rem}summary{padding:.7rem .85rem}
details>div{padding:0 .85rem 1rem}}
`.trim();

/** The cost figures, as a definition list rather than a chart. */
function costTable(c: FindingView['cost']): string {
  if (c.written + c.received === 0) return '';
  const rows: [string, string, string][] = [
    [approx(c.written), 'tokens written and discarded', ''],
  ];
  if (c.received > 0) rows.push([approx(c.received), 'received back', '']);
  if (c.carriedTurns > 0) {
    rows.push([
      approx(c.carried),
      `cache reads over ${c.carriedTurns} request${c.carriedTurns === 1 ? '' : 's'}`,
      '0.1× input',
    ]);
  }
  return raw(`<table><tbody>${rows
    .map(
      ([n, label, note]) =>
        `<tr><td class="n fig">${esc(n)}</td><td>${esc(label)}` +
        `${note === '' ? '' : ` <span class="mute">${esc(note)}</span>`}</td></tr>`,
    )
    .join('')}</tbody></table>`);
}

function findingBlock(f: FindingView): string {
  const times = f.occurrences > 1 ? `<span class="mute"> ×${f.occurrences}</span>` : '';
  const caveat = f.caveat === '' ? '' : `<span class="pill">${esc(f.caveat)}</span>`;

  const reasons = f.reasons
    .map(
      (r) =>
        `<tr><td>${esc(r.reason)}${r.count > 1 ? `<span class="mute"> ×${r.count}</span>` : ''}` +
        `</td><td class="mute">${esc(r.advice)}</td></tr>`,
    )
    .join('');

  const evidence = f.evidence
    .map((r) => {
      const mark = r.failed ? '<span class="bad">✗</span> ' : '';
      const detail = r.retry
        ? `<span class="mute">↻</span> ${esc(r.detail === '' ? 'retried' : r.detail)}`
        : esc(r.detail);
      return (
        `<tr><td class="n fig">${esc(r.turn)}</td>` +
        `<td>${mark}${esc(r.what)}</td><td class="mute">${detail}</td></tr>`
      );
    })
    .join('');

  const more =
    f.hidden > 0
      ? `<p class="note">… ${f.hidden} more cited turn${f.hidden === 1 ? '' : 's'} — ` +
        `<code>agentsensei skeleton</code></p>`
      : '';

  return raw(`<div class="finding">
<p class="dim-name">${esc(f.dimension)}${times}${caveat}</p>
<p class="subj">${esc(f.subject)}</p>
${costTable(f.cost)}
${reasons === '' ? '' : `<table><tbody>${reasons}</tbody></table>`}
<div class="scroll"><table>
<thead><tr><th class="n">turn</th><th>what</th><th>detail</th></tr></thead>
<tbody>${evidence}</tbody></table></div>
${more}
</div>`);
}

function sessionBlock(s: SessionView): string {
  const dur = duration(s.firstTs, s.lastTs);
  const n = s.findings.length;
  const wasted = s.cost.written > 0 ? approx(s.cost.written) : '';

  const head = [
    `<span class="fig">${esc(shortId(s.sessionId))}</span>`,
    `<span class="mute">${esc(s.project)}</span>`,
    dur === undefined ? '' : `<span class="mute">${esc(dur)}</span>`,
    `<span>${n} finding${n === 1 ? '' : 's'}</span>`,
    wasted === '' ? '' : `<span class="mute">${esc(wasted)} tokens discarded</span>`,
  ]
    .filter((x) => x !== '')
    .join('');

  const ratio =
    s.denominators.tokens.output > 0
      ? s.denominators.tokens.cacheCreation / s.denominators.tokens.output
      : undefined;

  const cost = raw(`<p class="note">${esc(human(s.denominators.tokens.output))} out · ${esc(
    human(s.denominators.tokens.cacheCreation),
  )} re-ingested${
    ratio === undefined
      ? ''
      : ` · ratio ${esc(ratio.toFixed(1))} (corpus median ${esc(CORPUS.reingestP50.toFixed(1))})`
  } · ${esc(String(s.denominators.editCount))} edits</p>`);

  const body =
    n === 0
      ? `<p class="note">no findings across ${esc(String(s.denominators.editCount))} edits</p>`
      : s.findings.map(findingBlock).join('');

  return raw(`<details><summary>${head}</summary><div>${cost}${body}</div></details>`);
}

export function renderHtml(d: ReportData): string {
  const total = d.sessions.reduce((a, s) => a + s.findings.length, 0);
  const span = (() => {
    const first = d.sessions.map((s) => s.firstTs).filter((t): t is string => t !== undefined);
    if (first.length === 0) return `${iso(d.range.from)} → ${iso(d.range.to)}`;
    const lo = first.reduce((a, b) => (a < b ? a : b));
    const last = d.sessions.map((s) => s.lastTs ?? '').filter((t) => t !== '');
    const hi = last.length > 0 ? last.reduce((a, b) => (a > b ? a : b)) : lo;
    return `${lo.slice(0, 10)} → ${hi.slice(0, 10)}`;
  })();

  // ── rollup ────────────────────────────────────────────────────────────────
  const rollup =
    d.standing.dimensions.length === 0
      ? `<div class="panel"><p class="note">no findings across ${esc(
          String(d.standing.edits),
        )} edits in ${esc(String(d.standing.sessions))} session(s)</p></div>`
      : raw(`<div class="panel"><div class="scroll"><table>
<thead><tr><th>dimension</th><th class="n">times</th><th class="n">sessions</th>
<th class="n">tokens discarded</th><th>recurs most in</th></tr></thead>
<tbody>${d.standing.dimensions
        .map((dim) => {
          // Summed from this dimension's own findings. `standing.wastedTokens`
          // is keyed by **reason**, not dimension, so folding it here gave
          // every row the whole report's total — invisible today with one
          // dimension live, wrong the moment there are two.
          const wasted = d.sessions
            .flatMap((s) => s.findings)
            .filter((f) => f.dimension === dim.dimension)
            .reduce((a, f) => a + f.cost.written, 0);
          return (
            `<tr><td class="dim-name">${esc(dim.dimension)}</td>` +
            `<td class="n fig">${esc(String(dim.occurrences))}</td>` +
            `<td class="n">${esc(String(dim.sessions))}</td>` +
            `<td class="n fig">${esc(approx(wasted))}</td>` +
            `<td class="subj">${esc(
              dim.top === undefined ? '—' : shortenPath(dim.top.subject, 40),
            )}</td></tr>`
          );
        })
        .join('')}</tbody></table></div></div>`);

  // ── coverage, from the sessions' own spans ────────────────────────────────
  const covered = d.sessions
    .filter((s) => s.firstTs !== undefined && s.lastTs !== undefined)
    .map((s) => ({ from: new Date(s.firstTs as string), to: new Date(s.lastTs as string) }));
  const segments = segmentByDepth(d.range, {
    covered,
    scanned: d.sessions.length > 0,
    // `history.jsonl` parsing is an M2 deliverable, so the shallow tier has no
    // backing yet. Claiming it would promise depth we cannot deliver.
    hasPromptHistory: false,
  });
  const coverage = raw(
    `<div class="panel">${describeCoverage(segments)
      .map((l) => `<p class="note">${esc(l.trim())}</p>`)
      .join('')}</div>`,
  );

  // ── the one recommendation, as `fix` words it ───────────────────────────────
  const r = d.recommendation;
  const oneThing =
    r === undefined
      ? ''
      : raw(`<h2>one thing to try</h2><div class="panel">
<p><span class="dim-name">${esc(r.dimension)}</span><span class="pill">${esc(r.kind)}</span></p>
<table><tbody>
<tr><td class="mute">measured</td><td>${esc(r.evidence)}</td></tr>
<tr><td class="mute">because</td><td>${esc(r.because)}</td></tr>${
        r.cost === undefined
          ? ''
          : `<tr><td class="mute">cost</td><td><span class="fig">${esc(
              approx(r.cost.written),
            )} tokens</span> <span class="mute">written and discarded</span></td></tr>`
      }
</tbody></table>
${r.prompt === undefined ? '' : `<p class="mute">for this session — paste or adopt</p><div class="scroll"><pre>${esc(r.prompt)}</pre></div>`}
${r.memory === undefined ? '' : `<p class="mute">to make it stick, add to CLAUDE.md</p><div class="scroll"><pre>${esc(r.memory)}</pre></div>`}
${r.prompt === undefined ? '' : `<p class="note">adopting this changes the session it is measuring, so this dimension will read as suppressed rather than improved until you drop it again.</p>`}
</div>`);

  const unreadable =
    d.unreadable > 0
      ? `<p class="note">${esc(String(d.unreadable))} discovered session(s) could not be read</p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentsensei report</title>
<style>${STYLE}</style></head>
<body><main>
<h1>agentsensei</h1>
<p class="sub">${esc(String(d.sessions.length))} session${d.sessions.length === 1 ? '' : 's'} · ${esc(
    span,
  )} · ${esc(String(total))} finding${total === 1 ? '' : 's'}</p>

<h2>rollup</h2>
${rollup}
${unreadable}

<h2>coverage</h2>
${coverage}
${oneThing}

<h2>sessions</h2>
${d.sessions.map(sessionBlock).join('')}

<footer>
generated ${esc(localStamp(d.generatedAt))} ·
preset ${esc(d.preset)}${d.muted.length > 0 ? ` · muted ${esc(d.muted.join(', '))}` : ''} ·
figures are lower bounds; see <code>src/cost.ts</code>
</footer>
</main></body></html>
`;
}
