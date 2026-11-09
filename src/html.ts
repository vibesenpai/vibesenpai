/**
 * The HTML report. Pure `(ReportData) → string`.
 * Every transcript value goes through `esc` (the only exception is an explicit `raw()`). Nothing
 * external is fetched; the CSP allows only `COPY_SCRIPT`, pinned by hash. A turn is always shown
 * beside the prompt it answered; cache figures appear only as evidence for a flagged rebuild.
 */

import { approx } from './cost.ts';
import { describeCoverage, segmentByDepth } from './range.ts';
import { REBUILDS_SHOWN, firstSentence, largestRebuilds, leadSegments, rebuildFact } from './render.ts';
import { alsoText, human, isoDay, localStamp, plural, shortenPath } from './format.ts';
import { projectLabel } from './read.ts';
import type { Rebuild } from './stats.ts';
import type { Asked, AskedRow, FindingView, JudgedView, ReportData, SessionView } from './gather.ts';
import type { Recommendation } from './fix.ts';
import { KIND_WORDS, type FindingFix, type SharedFix } from './finding-fix.ts';
import { fixDisplay } from './harness/fix-display.ts';
import { createHash } from 'node:crypto';
import { BANNER_JPEG, BANNER_SIZE, MARK_FAVICON, MARK_SVG } from './brand.ts';

/** Reveals the copy buttons and wires them; the fallback covers a browser that refuses the clipboard API on `file://`. */
export const COPY_SCRIPT = `for(const b of document.querySelectorAll('.copy')){b.hidden=false;b.addEventListener('click',()=>{const c=b.closest('.term').querySelector('code');const done=()=>{b.textContent='copied \u2713';setTimeout(()=>{b.textContent='copy'},1600)};const old=()=>{const r=document.createRange();r.selectNodeContents(c);const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');s.removeAllRanges();done()};navigator.clipboard?navigator.clipboard.writeText(c.textContent).then(done,old):old()})}`;
export const CSP = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(COPY_SCRIPT).digest('base64')}'`;

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


/** `10-19 14:02`, local — the year is in the page header already. */
const shortStamp = (isoTs: string): string => localStamp(isoTs).slice(5);

const shortId = (id: string): string => id.slice(0, 8);



/**
 * Light and dark themes on shared tokens. No severity colour: the two accents distinguish rule
 * from model findings only.
 */
const STYLE = `
:root{color-scheme:light;
--bg:#f7f7f5;--panel:#fff;--inset:#f1f1ee;--line:#e2e2de;--fg:#1c1c1a;--mute:#6b6b66;
--accent:#1f5f8b;--model:#6b4fb3;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--bg:#0f1216;--panel:#151a20;--inset:#0b0e12;--line:#262d36;--fg:#e6e8eb;--mute:#8b949e;
--accent:#7fb3d5;--model:#b69cf0}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem 4rem;background:var(--bg);color:var(--fg);
font:14px/1.6 var(--sans)}
main{max-width:64rem;margin:0 auto}
code,pre,.m,.fig,summary,table{font-family:var(--mono)}
h1{font:600 1.15rem/1.4 var(--mono);margin:0 0 .25rem;letter-spacing:-.01em}
h2{font:600 .74rem/1 var(--mono);text-transform:uppercase;letter-spacing:.09em;
margin:2.75rem 0 .9rem;padding-bottom:.6rem;border-bottom:1px solid var(--line);
display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
h2 small{font:400 .78rem var(--sans);text-transform:none;letter-spacing:0;color:var(--mute)}
h3{font:600 .8rem var(--mono);margin:1.4rem 0 .6rem}
.sub{color:var(--mute);margin:0}
.mute{color:var(--mute)}
.fig{font-weight:600;font-variant-numeric:tabular-nums}
.subj{color:var(--accent);word-break:break-all}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.75rem;margin:1.75rem 0 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.9rem 1rem}
.card .lbl{font:500 .68rem var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
.card .big{font:600 1.7rem/1.3 var(--mono);margin:.3rem 0 .15rem;font-variant-numeric:tabular-nums}
.card p{margin:0;font-size:.82rem;color:var(--mute)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1rem 1.15rem}
.boxes{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.6rem;margin:.8rem 0}
.box{background:var(--inset);border:1px solid var(--line);border-radius:4px;padding:.6rem .75rem;font-size:.86rem}
.hero{position:relative;margin:0 0 1.5rem;border-radius:8px;overflow:hidden;background:#0d1117}
.hero img{display:block;width:100%;height:auto}
.hero-text{position:absolute;left:5%;top:50%;transform:translateY(-50%);max-width:42%;color:#e6edf3}
.brand{display:flex;align-items:center;gap:.6rem;font:600 1.35rem var(--mono);letter-spacing:-.01em;margin:0 0 .35rem}
.brand svg{width:2.1rem;height:2.1rem;flex:none}
.pitch{margin:0;font-size:.95rem;color:#9fb3c8}
.foot-mark svg{width:1rem;height:1rem;vertical-align:-.2rem;margin-right:.35rem}
@media (max-width:640px){.hero-text{position:static;transform:none;max-width:none;padding:.75rem 1rem 1rem}.brand{font-size:1.1rem}}
.box .lbl{font:500 .66rem var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--mute);display:block;margin-bottom:.25rem}
pre{background:var(--inset);border:1px solid var(--line);border-radius:4px;padding:.6rem .75rem;
margin:.3rem 0 .8rem;white-space:pre-wrap;word-break:break-word;font-size:.84rem}
.pill{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:0 .4rem;
font:500 .68rem/1.6 var(--mono);color:var(--mute);text-transform:uppercase;letter-spacing:.05em}
.term{border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:.3rem 0 .8rem;background:var(--inset)}
.term-bar{display:flex;align-items:center;gap:.6rem;padding:.35rem .5rem .35rem .75rem;background:var(--panel);border-bottom:1px solid var(--line)}
.dots{display:flex;gap:.3rem}.dots i{width:.5rem;height:.5rem;border-radius:50%;background:var(--line)}
.term-lbl{font:500 .74rem var(--mono);color:var(--accent);flex:1;min-width:0}
.copy{font:500 .72rem var(--mono);color:var(--mute);background:none;border:1px solid var(--line);border-radius:4px;padding:.15rem .55rem;cursor:pointer}
.copy:hover{color:var(--fg);border-color:var(--mute)}.copy:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.term pre{margin:0;border:0;border-radius:0;background:none;padding:.75rem .9rem;display:flex;gap:.6rem}
.term .glyph{color:var(--accent);flex:none;user-select:none}
.term code{font:inherit}
details.moments{border-left:0}
table{width:100%;border-collapse:collapse;font-size:.82rem;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:500;color:var(--mute);font-size:.72rem;padding:.35rem .7rem .35rem 0;
border-bottom:1px solid var(--line)}
td{padding:.35rem .7rem .35rem 0;vertical-align:top;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;white-space:nowrap;width:1%}
.scroll{overflow-x:auto}
details{background:var(--panel);border:1px solid var(--line);border-radius:6px;margin:0 0 .5rem}
details.rule{border-left:3px solid var(--accent)}
details.model{border-left:3px solid var(--model)}
details details{background:var(--inset);margin:.5rem 0 0}
summary{cursor:pointer;position:relative;padding:.65rem 1rem .65rem 2.1rem;display:flex;flex-wrap:wrap;gap:.25rem .9rem;align-items:baseline;font-size:.84rem;list-style:none;border-radius:6px}
summary::-webkit-details-marker{display:none}
summary::before,.chev{content:'>';font:700 .9rem/1 var(--mono);color:var(--accent);display:inline-block;transition:transform .15s}
summary::before{position:absolute;left:.85rem;top:.78rem}
details[open]>summary::before{transform:rotate(90deg)}
summary:hover{background:var(--inset)}
summary:hover::before{color:var(--fg)}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.hint{display:flex;align-items:center;gap:.4rem;font:.76rem var(--mono);color:var(--mute);margin:.9rem 0 1.75rem}
.hint svg{width:1.1rem;height:1.1rem;flex:none}
.hint .chev{width:auto;margin-right:.35rem}
summary .end{margin-left:auto;color:var(--mute)}
summary .name{font-weight:600}
details>div{padding:0 1rem 1rem}
.asked{font-style:italic}
.where{color:var(--mute);font-size:.74rem}
.then{display:flex;flex-wrap:wrap;gap:.25rem .6rem;align-items:baseline}
.rec{background:var(--inset);border:1px solid var(--line);border-radius:6px;padding:.75rem .9rem;margin:.25rem 0 .75rem}
.rec-head{margin:0 0 .5rem;display:flex;align-items:center;gap:.5rem}
.fix{margin-top:1rem}
.fix .m{margin:.35rem 0}
.rec-head .lbl{font:600 .7rem var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--accent)}
.why{font-size:.88rem;margin:.5rem 0 0}
blockquote{margin:.5rem 0;padding:.4rem .75rem;border-left:2px solid var(--line);color:var(--mute);font:italic .84rem var(--mono)}
.note{color:var(--mute);font-size:.82rem;margin:.5rem 0 0}
.mark{font-weight:700;font-family:var(--mono)}
ul.plain{list-style:none;padding:0;margin:0}
ul.plain li{padding:.35rem 0;border-bottom:1px solid var(--line);font-size:.84rem}
ul.plain li:last-child{border-bottom:0}
.bar{display:flex;height:.55rem;border-radius:3px;overflow:hidden;background:var(--line);margin:.75rem 0 .35rem}
.bar span{display:block;height:100%}
.bar .full{background:var(--accent)}
.bar-ends{display:flex;justify-content:space-between;font:.72rem var(--mono);color:var(--mute)}
footer{color:var(--mute);font:.76rem var(--mono);margin-top:3rem;border-top:1px solid var(--line);padding-top:1rem}
footer .about{font:.8rem/1.5 var(--sans);margin:0 0 .75rem;max-width:70ch}
footer .about b{font-weight:600;color:var(--fg)}
@media(max-width:34rem){body{padding:1rem 1rem 3rem}summary{padding:.6rem .75rem .6rem 1.85rem}summary::before{left:.65rem;top:.72rem}
details>div{padding:0 .75rem .9rem}.card .big{font-size:1.4rem}}
`.trim();

// The prompt behind a turn

/** `“…”  10-19 14:02 · a1b2c3d4 · shop-api` */
function askedLine(a: Asked | undefined, s: SessionView): string {
  const where = `${shortId(s.sessionId)} · ${s.project}`;
  if (a === undefined) {
    return raw(`<span class="asked mute">no prompt precedes these turns</span><span class="where m">${esc(where)}</span>`);
  }
  const when = a.ts === undefined ? '' : `${shortStamp(a.ts)} · `;
  return raw(`<span class="asked">“${esc(a.text)}”</span><span class="where m">${esc(when + where)}</span>`);
}

/** Consecutive rows that answer the same prompt, kept in order. */
function byPrompt(rows: AskedRow[]): { asked?: Asked; rows: AskedRow[] }[] {
  const out: { asked?: Asked; rows: AskedRow[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last !== undefined && last.asked?.seq === r.asked?.seq) last.rows.push(r);
    else out.push({ ...(r.asked !== undefined ? { asked: r.asked } : {}), rows: [r] });
  }
  return out;
}

function evidenceTable(rows: AskedRow[]): string {
  const body = rows
    .map((r) => {
      const mark = r.failed ? '✗ ' : '';
      const detail = r.retry ? `↻ ${esc(r.detail === '' ? 'retried' : r.detail)}` : esc(r.detail);
      return (
        `<tr><td class="n fig">turn ${esc(r.turn)}</td>` +
        `<td>${esc(mark)}${esc(r.what)}</td><td class="mute">${detail}</td></tr>`
      );
    })
    .join('');
  return raw(`<div class="scroll"><table><tbody>${body}</tbody></table></div>`);
}

/** The cost of one finding, as plain figures rather than a chart. */
function findingCost(c: FindingView['cost']): string {
  if (c.written + c.received === 0) return '';
  const parts = [`${approx(c.written)} written and discarded`];
  if (c.received > 0) parts.push(`${approx(c.received)} received back`);
  if (c.carriedTurns > 0) parts.push(`carried ${plural(c.carriedTurns, 'request')}`);
  return raw(`<p class="note m">cost: ${esc(parts.join(' · '))}</p>`);
}

/** One rule finding in one session. Each prompt opens its own run of rows, so no turn sits under the wrong one. */
function ruleInstance(f: FindingView, s: SessionView): string {
  const groups = byPrompt(f.evidence);
  const head = groups[0];
  const rest = groups
    .map((g, i) =>
      (i === 0 ? '' : `<p class="note then"><span class="mute">then</span> ${askedLine(g.asked, s)}</p>`) + evidenceTable(g.rows),
    )
    .join('');
  const more =
    f.hidden > 0
      ? `<p class="note">… ${esc(plural(f.hidden, 'more cited turn'))} — <code>vibesenpai skeleton ${esc(
          shortId(s.sessionId),
        )}</code></p>`
      : '';
  const times = f.occurrences > 1 ? ` <span class="mute">×${esc(String(f.occurrences))}</span>` : '';
  return raw(`<details><summary>${askedLine(head?.asked, s)}<span class="subj">${esc(
    shortenPath(f.subject, 60),
  )}${times}</span></summary><div>${rest}${more}${findingCost(f.cost)}</div></details>`);
}

/**
 * One model finding, styled apart from rule findings. `why` is clamped at render time because
 * changing the rubric would invalidate the measured 165/232 (docs/eval.md).
 */
function judgedInstance(j: JudgedView, s: SessionView): string {
  const turns =
    j.turns.length === 0
      ? ''
      : `<p class="m"><span class="fig">turn${j.turns.length === 1 ? '' : 's'} ${esc(j.turns.join(', '))}</span>${esc(alsoText(j.secondaryDimensions))}</p>`;
  // Skip the quote when it just repeats the prompt line.
  const q = j.quote === undefined ? '' : firstSentence(j.quote, 200);
  const head = j.asked?.text.replace(/…$/, '') ?? '';
  const repeats = head !== '' && (head.includes(q) || q.startsWith(head));
  const quote = q === '' || repeats ? '' : `<blockquote>“${esc(q)}”</blockquote>`;
  return raw(`<details><summary>${askedLine(j.asked, s)}</summary><div>
${turns}${quote}${j.established === undefined ? '' : `<p class="m"><b>Established:</b> ${esc(firstSentence(j.established, 240))}</p>`}<p class="why">${esc(firstSentence(j.why, 240))}</p>
${j.fix === undefined ? '' : fixBlock(j.fix)}</div></details>`);
}

// Sections

function figures(d: ReportData, f: Facts): string {
  const card = (label: string, big: string, sub: string): string =>
    `<div class="card"><div class="lbl">${esc(label)}</div><div class="big">${esc(big)}</div><p>${esc(sub)}</p></div>`;
  const read = d.unreadable > 0
    ? `${d.sessions.length} of ${d.sessions.length + d.unreadable} read`
    : `${plural(f.projects, 'project')}`;
  return raw(`<div class="cards">
${card('sessions', String(d.sessions.length), read)}
${card('findings', String(f.ruleCount + f.judgedCount), `across ${plural(new Set(d.sessions.filter((s) => s.findings.length + s.judged.length > 0).map((s) => s.sessionId)).size, 'session')}`)}
${card('tokens discarded', f.wasted > 0 ? approx(f.wasted) : '0', 'written for calls the harness refused')}
${f.rebuildCount === 0 ? '' : card('! cache', plural(f.rebuildCount, 'rebuild'), `${human(f.rebuildTokens)} tokens written again from scratch`)}
</div>`);
}

/** Pasteable text drawn as a terminal window. The `❯` sits outside `<code>`, so it is never copied. */
function term(label: string, text: string, prompt = false): string {
  return `<div class="term"><div class="term-bar"><span class="dots"><i></i><i></i><i></i></span><span class="term-lbl">${esc(
    label,
  )}</span><button type="button" class="copy" hidden>copy</button></div><pre>${
    prompt ? '<span class="glyph" aria-hidden="true">❯</span>' : ''
  }<code>${esc(text)}</code></pre></div>`;
}

/**
 * A fix built from one finding, or shared by several: what it does, the text to copy, where it lands.
 * Problem first: it closes the finding or dimension it belongs to.
 */
function fixBlock(x: FindingFix, shared?: SharedFix): string {
  const { destination, body } = fixDisplay(x);
  const scope = x.paths === undefined ? '' : ` · for ${x.paths.join(', ')}`;
  const projects = (shared?.projects ?? [x.project]).map(projectLabel).join(' and ');
  const where = !x.applicable
    ? 'A Stop hook has no Apply: it needs your paths or test command filled in, and an unfinished one would block every turn.'
    : x.kind === 'check'
      ? `The agent shows you the test before adding it, in ${projects}.`
      : `Added to ${destination} in ${projects}${scope}`;
  const lead =
    shared !== undefined
      ? `<p class="m">For ${esc(plural(shared.findings, 'finding'))} in ${esc(plural(shared.sessions, 'session'))}${x.kind === 'agent' ? ' where a question got an edit' : ''}.</p>`
      : x.kind === 'check'
        ? `<p class="m">${esc(x.source.from ?? 'The project instructions')} already says this, and it was broken anyway.</p>`
        : '';
  return `<div class="rec fix"><p class="rec-head"><span class="lbl">fix</span></p>${lead}<p class="m">${esc(KIND_WORDS[x.kind])}</p>
${term(x.kind === 'check' ? 'the rule · the agent proposes a test for it' : destination, body)}
<p class="note">${esc(where)}</p></div>`;
}

/** A dimension's recommendation, as `fix` words it, shown after that dimension's evidence. */
function recBlock(r: Recommendation | undefined): string {
  if (r === undefined) return '';
  const box = (label: string, body: string): string =>
    `<div class="box"><span class="lbl">${esc(label)}</span>${body}</div>`;
  const boxes = [
    box('measured', esc(r.evidence)),
    box('why it helps', esc(r.promptHelps ?? r.because)),
    r.cost === undefined
      ? ''
      : box('cost so far', `<span class="fig">${esc(approx(r.cost.written))} tokens</span> written and discarded`),
  ].join('');
  const config =
    r.config === undefined
      ? ''
      : `<p class="note">${esc(r.config.what)} — ${esc(r.config.costs)}</p>${term('setting · how to turn it on', r.config.snippet)}`;
  return `<div class="rec"><p class="rec-head"><span class="lbl">recommendation</span> <span class="pill">${esc(r.kind)}</span></p>
<div class="boxes">${boxes}</div>
${config}
${r.prompt === undefined ? '' : term('prompt · paste into your session', r.prompt, true)}
${r.rule === undefined ? '' : term('a standing rule · to make it stick', r.rule)}
${r.prompt === undefined ? '' : `<p class="note">adopting this changes the sessions it is measuring, so this dimension will read as suppressed rather than improved until you drop it again.</p>`}
</div>`;
}

function findingsSection(d: ReportData, f: Facts): string {
  if (f.ruleCount + f.judgedCount === 0) {
    return raw(`<h2>Findings</h2><div class="panel"><p class="note">no findings across ${esc(
      String(d.standing.edits),
    )} edits in ${esc(plural(d.standing.sessions, 'session'))}</p></div>`);
  }

  const blocks: { times: number; html: string }[] = [];
  const moments = (n: number, sessions: number, body: string): string =>
    `<details class="moments"><summary><span class="name">${esc(plural(n, 'moment'))}</span><span class="mute">${esc(
      `in ${plural(sessions, 'session')} — the prompts and the turns`,
    )}</span></summary><div>${body}</div></details>`;

  // Dimensions from the findings shown, not from the standing.
  const ruleDims = [...new Set(d.sessions.flatMap((s) => s.findings.map((x) => x.dimension)))];
  for (const dim of ruleDims) {
    const inst = d.sessions.flatMap((s) =>
      s.findings.filter((x) => x.dimension === dim).map((x) => ({ s, f: x })),
    );
    const times = inst.reduce((n, i) => n + i.f.occurrences, 0);
    const sessions = new Set(inst.map((i) => i.s.sessionId)).size;
    // From this dimension's findings: `standing.wastedTokens` is keyed by reason.
    const wasted = inst.reduce((n, i) => n + i.f.cost.written, 0);
    const top = d.standing.dimensions.find((x) => x.dimension === dim)?.top;

    const reasons = new Map<string, number>();
    for (const i of inst) for (const r of i.f.reasons) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count);
    const reasonLine =
      reasons.size === 0
        ? ''
        : `<p class="note m">harness reasons: ${[...reasons]
            .sort((a, b) => b[1] - a[1])
            .map(([r, n]) => `${esc(r)} ×${esc(String(n))}`)
            .join(' · ')}</p>`;

    blocks.push({
      times,
      html: `<details class="rule"><summary><span class="name">${esc(dim)}</span><span class="mute">${esc(
        `${plural(times, 'time')} · ${plural(sessions, 'session')}`,
      )}${top === undefined ? '' : ` · most in <span class="subj">${esc(shortenPath(top.subject, 40))}</span>`}</span>${
        wasted > 0 ? `<span class="end">${esc(approx(wasted))} tokens discarded</span>` : ''
      }</summary><div>${moments(inst.length, sessions, reasonLine + inst.map((i) => ruleInstance(i.f, i.s)).join(''))}${recBlock(
        d.recommendations[dim],
      )}</div></details>`,
    });
  }

  const judgedDims = new Map<string, { s: SessionView; j: JudgedView }[]>();
  for (const s of d.sessions) {
    for (const j of s.judged) judgedDims.set(j.dimension, [...(judgedDims.get(j.dimension) ?? []), { s, j }]);
  }
  for (const [dim, inst] of judgedDims) {
    const sessions = new Set(inst.map((i) => i.s.sessionId)).size;
    const turns = inst.reduce((n, i) => n + i.j.turns.length, 0);
    blocks.push({
      times: inst.length,
      html: `<details class="model"><summary><span class="name">${esc(dim)}</span><span class="mute">${esc(
        `${plural(inst.length, 'time')} · ${plural(sessions, 'session')}`,
      )}</span><span class="end">${esc(plural(turns, 'turn'))} cited</span></summary><div>${moments(
        inst.length,
        sessions,
        inst.map((i) => judgedInstance(i.j, i.s)).join(''),
      )}${d.shared?.[dim] !== undefined ? fixBlock(d.shared[dim].fix, d.shared[dim]) : recBlock(d.recommendations[dim])}</div></details>`,
    });
  }

  // Biggest first; a stable sort keeps rule findings ahead on a tie.
  blocks.sort((a, b) => b.times - a.times);
  return raw(`<h2>Findings <small>specific turns in specific sessions</small></h2>
${blocks.map((b) => b.html).join('')}`);
}

/** One rebuild as a list item, worded by `rebuildFact` like the terminal. */
function rebuildItem(r: Rebuild, where = ''): string {
  const fact = rebuildFact(r);
  return `<li><span class="mark">!</span> ${esc(fact.head)}${where}<br><span class="fig">${esc(fact.figure)}</span> <span class="mute">${esc(
    fact.note,
  )}</span></li>`;
}

/** Cache: flagged rebuilds only, plus compactions. Absent when nothing was flagged. */
function cacheSection(d: ReportData): string {
  const flagged = d.sessions.flatMap((s) => (s.stats.rebuilds?.events ?? []).map((r) => ({ r, s })));
  const ranked = flagged.sort((a, b) => b.r.tokens - a.r.tokens);
  const shown = ranked.slice(0, REBUILDS_SHOWN);
  const rest = ranked.length - shown.length;
  const flags =
    ranked.length === 0
      ? ''
      : `<h2>Cache <small>flagged events only</small></h2>
<ul class="plain">${shown
          .map(({ r, s }) =>
            rebuildItem(r, ` <span class="mute">· ${esc(shortId(s.sessionId))} · ${esc(s.project)}</span>`),
          )
          .join('')}${rest > 0 ? `<li class="mute">and ${esc(String(rest))} more, in their sessions below</li>` : ''}</ul>`;

  // Compactions per session: stated, not judged.
  const compacted = d.sessions
    .filter((s) => s.stats.compactions.count > 0)
    .map((s) => {
      const c = s.stats.compactions;
      return `<li><span class="m">${esc(shortId(s.sessionId))}</span> <span class="mute">${esc(s.project)}</span> — ${esc(
        `compacted ${c.count === 1 ? 'once' : `${c.count}×`}${c.dropped > 0 ? `, ${human(c.dropped)} dropped` : ''}`,
      )}</li>`;
    });
  const compactions = d.sessions.reduce((n, s) => n + s.stats.compactions.count, 0);
  const context =
    compacted.length === 0
      ? ''
      : `<details style="margin-top:.75rem"><summary><span class="name">compactions</span><span class="mute">${esc(
          plural(compactions, 'compaction'),
        )} · ${esc(plural(compacted.length, 'session'))}</span></summary><div><ul class="plain">${compacted.join('')}</ul></div></details>`;

  return raw(`${flags}${context}`);
}

/** The findings inside one session, in one line each, with the prompt. */
function sessionFindings(s: SessionView): string {
  const items = [
    ...s.findings.map((f) => {
      const turns = f.evidence.map((r) => r.turn).join(', ');
      return `<li><span class="name">${esc(f.dimension)}</span> <span class="subj">${esc(
        shortenPath(f.subject, 40),
      )}</span><br>${askedLine(f.evidence[0]?.asked, s)}<br><span class="mute m">turns ${esc(turns)}</span></li>`;
    }),
    ...s.judged.map(
      (j) =>
        `<li><span class="name">${esc(j.dimension)}</span>${esc(alsoText(j.secondaryDimensions))}<br>${askedLine(
          j.asked,
          s,
        )}<br><span class="mute m">turns ${esc(j.turns.join(', '))}</span></li>`,
    ),
  ];
  return raw(`<ul class="plain">${items.join('')}</ul>`);
}

function sessionBlock(s: SessionView): string {
  // Occurrences, matching the header count.
  const n = s.findings.reduce((m, f) => m + f.occurrences, 0) + s.judged.length;
  const den = s.denominators;
  const span =
    s.firstTs === undefined
      ? ''
      : `${shortStamp(s.firstTs)}${s.lastTs === undefined ? '' : ` → ${shortStamp(s.lastTs)}`}`;

  const head = [
    `<span class="name">${esc(shortId(s.sessionId))}</span>`,
    `<span class="mute">${esc(s.project)}</span>`,
    span === '' ? '' : `<span class="mute">${esc(span)}</span>`,
    // Separate figures, never `edits / calls`: `editCount` can exceed the call count.
    `<span class="mute">${esc(
      `${plural(den.turnCount, 'prompt')} · ${den.toolCallCount.toLocaleString('en-US')} calls, ${den.failedCallCount.toLocaleString('en-US')} failed · ${plural(den.editCount, 'edit')}`,
    )}</span>`,
    `<span class="end">${esc(plural(n, 'finding'))}</span>`,
  ]
    .filter((x) => x !== '')
    .join('');

  // Cache numbers only as evidence for a flag, as in `cacheSection`.
  const rebuilds = s.stats.rebuilds?.events ?? [];
  const flags =
    rebuilds.length === 0
      ? ''
      : `<h3>cache</h3><ul class="plain">${largestRebuilds(rebuilds).map((r) => rebuildItem(r)).join('')}</ul>`;

  const comp = s.stats.compactions;
  const context =
    comp.count === 0
      ? ''
      : `<p class="note">compacted ${esc(comp.count === 1 ? 'once' : `${comp.count}×`)}${
          comp.dropped > 0 ? ` — dropped <span class="fig">${esc(human(comp.dropped))}</span> tokens of context` : ''
        }</p>`;

  const files = s.stats.rewritten.slice(0, 5);
  const rewritten =
    files.length === 0
      ? ''
      : `<h3>most-rewritten files</h3><div class="scroll"><table><thead><tr><th>file</th><th class="n">versions</th><th class="n">edit calls</th></tr></thead><tbody>${files
          .map(
            (f) =>
              `<tr><td class="subj">${esc(shortenPath(f.path, 60))}</td><td class="n">${esc(String(f.versions))}</td><td class="n">${esc(
                String(f.editCalls),
              )}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;

  const body =
    n === 0
      ? `<p class="note">no findings across ${esc(String(den.editCount))} edits</p>`
      : `<h3>findings in this session</h3>${sessionFindings(s)}`;

  return raw(`<details><summary>${head}</summary><div>${context}${flags}${rewritten}${body}</div></details>`);
}

/** The first few sessions in view, the rest one click further down. */
const SESSIONS_SHOWN = 6;

function sessionsSection(d: ReportData): string {
  const shown = d.sessions.slice(0, SESSIONS_SHOWN).map(sessionBlock).join('');
  const rest = d.sessions.slice(SESSIONS_SHOWN);
  const more =
    rest.length === 0
      ? ''
      : `<details><summary><span class="name">${esc(plural(rest.length, 'more session'))}</span><span class="mute">${esc(
          plural(rest.reduce((n, s) => n + s.findings.reduce((m, f) => m + f.occurrences, 0) + s.judged.length, 0), 'finding'),
        )} between them</span></summary><div>${rest.map(sessionBlock).join('')}</div></details>`;
  return raw(`<h2>Sessions <small>${esc(plural(d.sessions.length, 'session'))}, findings first</small></h2>${shown}${more}`);
}

function coverageSection(d: ReportData): string {
  const covered = d.sessions
    .filter((s) => s.firstTs !== undefined && s.lastTs !== undefined)
    .map((s) => ({ from: new Date(s.firstTs as string), to: new Date(s.lastTs as string) }));
  const segments = segmentByDepth(d.range, {
    covered,
    scanned: d.sessions.length > 0,
    // `history.jsonl` is not parsed yet, so the shallow tier has no backing.
    hasPromptHistory: false,
  });

  // Same segments as the text below, so they cannot disagree. Gaps are grey, not a fault.
  const total = segments.reduce((n, g) => n + Math.max(0, g.to.getTime() - g.from.getTime()), 0);
  const bar =
    total <= 0 || segments.length < 2
      ? ''
      : `<div class="bar">${segments
          .map((g) => {
            const w = ((g.to.getTime() - g.from.getTime()) / total) * 100;
            return `<span class="${g.depth === 'full' ? 'full' : ''}" style="width:${w.toFixed(2)}%"></span>`;
          })
          .join('')}</div><div class="bar-ends"><span>${esc(isoDay(d.range.from))}</span><span>${esc(isoDay(d.range.to))}</span></div>`;

  const unreadable =
    d.unreadable > 0 ? `<p class="note">${esc(String(d.unreadable))} discovered session(s) could not be read</p>` : '';
  return raw(`<h2>Coverage <small>what was read</small></h2>
<div class="panel">${bar}${describeCoverage(segments)
    .map((l) => `<p class="note m">${esc(l.trim())}</p>`)
    .join('')}${unreadable}
<p class="note">history beyond the harness's retention is not kept — vibesenpai stores no transcript copies</p></div>`);
}

// The page

type Facts = {
  ruleCount: number;
  judgedCount: number;
  wasted: number;
  rebuildCount: number;
  rebuildTokens: number;
  projects: number;
};

export function renderHtml(d: ReportData): string {
  // Occurrences, not grouped findings, to match `standing`.
  const f: Facts = {
    ruleCount: d.sessions.reduce((n, s) => n + s.findings.reduce((m, x) => m + x.occurrences, 0), 0),
    judgedCount: d.sessions.reduce((n, s) => n + s.judged.length, 0),
    wasted: d.sessions.reduce((n, s) => n + s.cost.written, 0),
    rebuildCount: d.sessions.reduce((n, s) => n + (s.stats.rebuilds?.count ?? 0), 0),
    rebuildTokens: d.sessions.reduce((n, s) => n + (s.stats.rebuilds?.tokens ?? 0), 0),
    projects: new Set(d.sessions.map((s) => s.project)).size,
  };

  const span = (() => {
    const first = d.sessions.map((s) => s.firstTs).filter((t): t is string => t !== undefined);
    if (first.length === 0) return `${isoDay(d.range.from)} → ${isoDay(d.range.to)}`;
    const lo = first.reduce((a, b) => (a < b ? a : b));
    const last = d.sessions.map((s) => s.lastTs ?? '').filter((t) => t !== '');
    const hi = last.length > 0 ? last.reduce((a, b) => (a > b ? a : b)) : lo;
    return `${lo.slice(0, 10)} → ${hi.slice(0, 10)}`;
  })();

  // Headline: priced waste if any, then one finding count (only rule findings are priced).
  const total = f.ruleCount + f.judgedCount;
  const seg =
    total === 0
      ? leadSegments({ ruleCount: 0, judgedCount: 0, total: 0, wasted: 0, editCount: d.standing.edits })
      : f.wasted > 0
        ? { figure: `${approx(f.wasted)} tokens`, rest: ` discarded · ${plural(total, 'finding')}` }
        : { figure: plural(total, 'finding'), rest: ` across ${plural(d.standing.edits, 'edit')}` };
  const lead =
    seg.figure === undefined ? esc(seg.rest) : `${esc(seg.figure)}<span class="mute">${esc(seg.rest)}</span>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>vibesenpai report</title>
<link rel="icon" href="${MARK_FAVICON}">
<style>${STYLE}</style></head>
<body><main>
<header class="hero">
<img src="${BANNER_JPEG}" alt="" width="${BANNER_SIZE.width}" height="${BANNER_SIZE.height}">
<div class="hero-text"><p class="brand">${MARK_SVG}<span>vibesenpai</span></p><p class="pitch">Discover how your agents failed you.</p></div>
</header>
<h1>${raw(lead)}</h1>
<p class="sub m">${esc(plural(d.sessions.length, 'session'))} · ${esc(span)} · ${esc(plural(f.projects, 'project'))}</p>
${figures(d, f)}
<p class="hint">${MARK_SVG}<span><span class="chev">&gt;</span> rows marked like this open — click one to drill in</span></p>
${findingsSection(d, f)}
${cacheSection(d)}
${sessionsSection(d)}
${coverageSection(d)}
<footer>
<p class="about"><b>About these numbers.</b> Most findings are an AI model’s reading of your sessions and can be wrong — check the quoted turn before acting on one. The rest come from the harness’s own refusals. Discarded-token figures are estimated from your transcripts and are lower bounds; cache figures are the harness’s own counts.</p>
<span class="foot-mark">${MARK_SVG}</span><strong>vibesenpai</strong> ·
generated ${esc(localStamp(d.generatedAt))} ·
preset ${esc(d.preset)}${d.muted.length > 0 ? ` · muted ${esc(d.muted.join(', '))}` : ''}
</footer>
</main><script>${COPY_SCRIPT}</script></body></html>
`;
}
