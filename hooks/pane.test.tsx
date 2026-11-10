// The insights pane, against a stubbed engine and a stubbed `vibesenpai report --json`.
import { expect, mock, test, type TestBody } from 'claude-code/testing'

import type { PaneData } from '../types'
import { DOCS, aboutTime, barRuns, dimensionDocs, finishDay } from './shape.ts'

const NOW = new Date().toISOString()
const EARLIER = '2026-10-01T10:00:00.000Z'

const DATA: PaneData = {
  archive: '/archive',
  read: 2,
  total: 3,
  health: [{ job: 'standing', state: 'ok' }, { job: 'judge', state: 'ok' }],
  recommendations: {
    misread_intent: { dimension: 'misread_intent', prompt: 'For the rest of this session: before acting on anything ambiguous, state the request.' },
  },
  fixes: [
    { fixId: '16ae85', dimension: 'misread_intent', target: 'project-instructions', text: '- Before acting on anything ambiguous, state the request.', destination: '.claude/rules/vibesenpai.md', request: 'unused' },
    { fixId: '298aaf', dimension: 'edit_retry', target: 'project-instructions', text: '- Re-read right before editing.', destination: '.claude/rules/vibesenpai.md', request: 'unused' },
    {
      fixId: 'dea0d0', dimension: 'overreach', target: 'project-instructions', text: '- Do only what was asked.', destination: '.claude/rules/vibesenpai.md', request: 'unused',
      applied: { at: '2026-10-21T10:00:00.000Z', sessionId: 'aaaaaaaa-1111' }, inEffect: true,
      before: { times: 4, sessions: 9 }, since: { times: 1, sessions: 4 }, cameBack: { sessionId: '9b0e44d1-xxxx', turn: 88 },
    },
    {
      fixId: '3704ae', dimension: 'inaccurate_self_report', target: 'project-instructions', text: '- Quote the output.', destination: '.claude/rules/vibesenpai.md', request: 'unused',
      applied: { at: '2026-10-22T10:00:00.000Z', sessionId: 'aaaaaaaa-1111' }, inEffect: false,
    },
  ],
  spend: {
    allTime: { calls: 114, tokensIn: 3_800_000, tokensOut: 226_000, usdMicros: 1_870_000, usdSince: '2026-10-29T10:00:00.000Z' },
    last7d: { calls: 12, tokensIn: 610_000, tokensOut: 40_000, usdMicros: 310_000 },
    today: { tokens: 610_000, limit: 2_000_000 },
    older: 3, catchUp: 200, enabled: true, billing: 'unknown',
  },
  dismissed: 4,
  sessions: [
    {
      sessionId: 'aaaaaaaa-1111',
      project: 'app',
      lastTs: EARLIER,
      findings: [
        {
          id: 'subjectkey1',
          dimension: 'edit_retry',
          subject: 'src/a.ts',
          occurrences: 2,
          reasons: [{ reason: 'string-not-found', count: 2 }],
          cost: { written: 1200 },
          evidence: [{ turn: '7', what: 'refused', detail: 'string-not-found', failed: true, retry: false }],
        },
      ],
      judged: [
        { id: 'judged-old', at: EARLIER, dimension: 'misread_intent', turns: [4], why: 'Read the question as a request.', quote: 'are we planning trends?' },
        { id: 'judged-new', at: NOW, dimension: 'misread_intent', secondaryDimensions: ['overreach'], turns: [9], why: 'Kept the plain name.', quote: 'I want it to be /vibesenpai:fix', quoteBy: 'developer', asked: { seq: 8, text: 'rename the command' }, established: 'turn 3 — “call it /vibesenpai:fix”' },
      ],
      stats: { rebuilds: { count: 1, tokens: 120_000, events: [{ seq: 30, tokens: 120_000, cached: 140_000, gapMinutes: 75 }] } },
    },
  ],
}

const PANE = {
  plugin: 'vibesenpai',
  component: 'Pane',
  requestId: 'insights',
  props: { title: 'vibesenpai', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Calls = { argv: string[][]; filled: string[]; draft?: string; refuse?: 'dialog' | 'no_composer'; copied?: string; copyFails?: boolean; noOpener?: boolean; mtime?: number; rateLimits?: { kind: string; percentUsed: number }[]; excerpt?: unknown }

/** Run `/vibesenpai:insights`; the kit fills the fields a typed command carries. */
const insights = ($: Parameters<TestBody>[0]) => $.command.run({ command: 'vibesenpai:insights' } as never)

/** The engine beneath the plugin: a placed pane, a store that last saw us in the past, and our CLI answering. */
function engine(on: Parameters<TestBody>[1], data: PaneData | null, calls: Calls, isPlaced = true, termProgram?: string): void {
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'TERM_PROGRAM' ? termProgram : undefined }))
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no room' } }))
  on('store.get', () => ({ value: '2026-10-10T00:00:00.000Z' }))
  on('store.set', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: calls.mtime ?? 1, isLink: false } }))
  on('prompt.read', () => ({ value: { text: calls.draft ?? '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    if (calls.refuse !== undefined) return { isFilled: false, refusal: calls.refuse }
    calls.filled.push((e as { text: string }).text)
    return { isFilled: true }
  })
  on('ui.copy', (_, e) => {
    if (calls.copyFails === true) return { value: { isCopied: false } }
    calls.copied = (e as { text: string }).text
    return { value: { isCopied: true } }
  })
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    calls.argv.push([...argv])
    if (calls.noOpener === true && (argv[0] === 'open' || argv[0] === 'xdg-open')) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // `dismiss --all` prints its own count, as the CLI does.
    if (argv.includes('dismiss') && argv.includes('--all')) return { value: { exitCode: 0, stdout: '  Cleared 3 findings.\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const out = argv.includes('excerpt') ? calls.excerpt ?? { kept: false } : data
    return { value: { exitCode: 0, stdout: out === null ? '' : JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: 'the text version' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: calls.rateLimits ?? [] } as never }))
}

test('opens on the command, reads the analysis, and shows new findings first', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  const r = await insights($)
  expect(r.text).toBe('Insights opened beside the chat.')
  expect(calls.argv[0]?.slice(-2)).toEqual(['report', '--json'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /2\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /New since you last looked/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /│ Findings │/ })).toBeDefined()
    // How a finding was flagged is never shown.
    expect(await ui.find({ type: 'Text', text: /flagged by/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /also overreach/ })).toBeDefined()
    await ui.unmount()
  }
})

test('falls through to the text version where no pane can be placed', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls, false)
  const r = await insights($)
  expect(r.text).toBe('the text version')
  expect(calls.argv).toHaveLength(0)
})

test('a finding expands to its turns and reason, and Dismiss calls the CLI with its id', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /You asked:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rename the command/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Why: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Kept the plain name/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /call it \/vibesenpai:fix/ })).toBeDefined()

  await ui.press({ key: 'dismiss:judged-new' })
  expect(calls.argv.some((a) => a.includes('dismiss') && a.includes('judged-new'))).toBe(true)
  await ui.unmount()
})

test('Apply drafts the request into an empty prompt box, with the marker, and never sends it', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The one solid button: the action to take.
  expect(JSON.stringify(await ui.find({ type: 'Button', key: 'apply:16ae85' }))).toMatch(/"backgroundColor":"claude"/)
  const tree = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(tree).toMatch(/"label":"Apply"/)
  expect(tree).not.toMatch(/"label":"Copy/)
  // The fix says what kind of change it is and where it lands, not just its words.
  expect(await ui.find({ type: 'Text', text: /A rule the agent reads in every session of this project:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Added to \.claude\/rules\/vibesenpai\.md/ })).toBeDefined()
  await ui.press({ key: 'apply:16ae85' })
  expect(calls.filled).toHaveLength(1)
  expect(calls.filled[0]).toMatch(/Add this line to \.claude\/rules\/vibesenpai\.md/)
  expect(calls.filled[0]).toMatch(/\(vibesenpai fix 16ae85\)$/)
  // The pressed fix folds to one line, and its Apply goes away.
  expect(await ui.find({ type: 'Text', text: /^✓ Fix drafted in your prompt box\. Press Enter to apply it\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Rules load when a session starts, so it takes effect in your next session, or after \/compact\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'apply:16ae85' })).toBeUndefined()

  await ui.unmount()
})

test('Apply leaves a draft the person typed alone', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], draft: 'half a thought' }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'apply:16ae85' })
  expect(calls.filled).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Your prompt box has a draft\. Clear it, then press Apply again\./ })).toBeDefined()
  await ui.unmount()
})

test('the Fixes tab applies several as one request, and says how an applied one did', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:fixes' })
  expect(await ui.find({ type: 'Text', text: /│ Fixes │/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'apply-picked' })).toBeUndefined()
  await ui.press({ key: 'pick:16ae85' })
  await ui.press({ key: 'pick:298aaf' })
  expect((await ui.find({ type: 'Button', key: 'apply-picked' }))?.props['label']).toBe('Apply 2')
  await ui.press({ key: 'apply-picked' })
  expect(calls.filled[0]).toMatch(/these lines/)
  expect(calls.filled[0]).toMatch(/\(vibesenpai fix 16ae85, 298aaf\)$/)
  expect(await ui.find({ type: 'Text', text: /Applied Oct 21/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4 times in 9 sessions/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 time in 4 sessions/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Came back/ })).toBeUndefined()
  // Requested but never loaded: still offered, since the developer may have said no.
  expect(await ui.find({ type: 'Text', text: /requested Oct 22, in effect from your next session/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pick:3704ae' })).toBeDefined()
  await ui.unmount()
})

test('with every fix applied, the Fixes tab drops the Waiting heading', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, { ...DATA, fixes: DATA.fixes!.filter((x) => x.inEffect === true) }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:fixes' })
  expect(await ui.find({ type: 'Text', text: /^Waiting$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Every fix on offer is applied/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Applied$/ })).toBeDefined()
  await ui.unmount()
})

test('the Health tab states the jobs, what was read and what was spent', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:health' })
  expect(await ui.find({ type: 'Text', text: /2 of 3 sessions read/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /610k of 2\.0M tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^114 calls · 3\.8M in · 226k out · \$1\.87$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /on a subscription it comes out of your plan's usage instead/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 past sessions not read/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /judge off stops them/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4 findings/ })).toBeDefined()
  await ui.unmount()
})

test('on a subscription, Health says the dollars are not a bill, and shows nothing of the plan beyond vibesenpai', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], rateLimits: [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'seven_day', percentUsed: 12.4 }] }
  engine(on, { ...DATA, spend: { ...DATA.spend!, today: { tokens: 2_000_000, limit: 2_000_000 } } }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:health' })
  expect(await ui.find({ type: 'Text', text: /5-hour limit|Claude usage/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /comes out of your plan's usage, not a bill/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /budget reached, continues tomorrow/ })).toBeDefined()
  await ui.unmount()
})

test('an empty history says so instead of throwing', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, { ...DATA, sessions: [], recommendations: {}, fixes: [], read: 0, total: 0 }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing flagged in 0 sessions read/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow pane clips quotes rather than overflowing', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const long = 'x'.repeat(200)
  engine(on, { ...DATA, sessions: [{ ...DATA.sessions[0]!, judged: [{ id: 'j', at: NOW, dimension: 'misread_intent', turns: [1], why: 'w', quote: long }] }] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  const label = String((await ui.find({ type: 'Button', key: 'item:new:j' }))?.props['label'] ?? '')
  expect(label).toMatch(/…/)
  expect(label.length).toBeLessThan(40)
  await ui.unmount()
})

test('the new finding comes before the fix, and the fix is shown in full', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(texts.indexOf('I want it to be')).toBeLessThan(texts.indexOf('Before acting on anything ambiguous'))
  // A dimension's findings come before its fix, so Apply sits below the evidence.
  expect(texts.indexOf('"key":"list:misread_intent"')).toBeGreaterThan(-1)
  expect(texts.indexOf('"key":"list:misread_intent"')).toBeLessThan(texts.indexOf('"key":"apply:16ae85"'))
  // No hotkeys on the tabs: the terminal prints them as a "1:" prefix.
  expect((await ui.find({ type: 'Button', key: 'tab:fixes' }))?.props['hotkey']).toBeUndefined()
  // Wrapped by hand so every line of the prompt starts with the bar.
  expect(await ui.find({ type: 'Text', text: /^▎ Before acting on anything ambiguous,/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▎ request\.$/ })).toBeDefined()
  await ui.unmount()
})


test('the first block starts open and collapses when pressed', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = DATA.sessions[0]!.judged[0]!.dimension
  expect(await ui.find({ type: 'Button', key: 'apply:16ae85' })).toBeDefined()
  await ui.press({ key: `block:${first}` })
  expect(await ui.find({ type: 'Button', key: 'apply:16ae85' })).toBeUndefined()
  await ui.press({ key: `block:${first}` })
  expect(await ui.find({ type: 'Button', key: 'apply:16ae85' })).toBeDefined()
  await ui.unmount()
})

test('Suggestion records a label with the CLI', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  await ui.press({ key: 'suggestion:judged-new' })
  expect(calls.argv.some((a) => a.join(' ').endsWith('label judged-new suggestion'))).toBe(true)
  await ui.unmount()
})

test('a dimension lists its findings only when its accordion is opened', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'item:misread_intent:judged-old' })).toBeUndefined()
  await ui.press({ key: 'list:misread_intent' })
  expect(await ui.find({ type: 'Button', key: 'item:misread_intent:judged-old' })).toBeDefined()
  await ui.unmount()
})

test('a finding offers Finding is wrong, Not the agent\'s fault and Hide, and no Yes', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect((await ui.find({ type: 'Button', key: 'wrong:judged-new' }))?.props['label']).toBe('Finding is wrong')
  expect((await ui.find({ type: 'Button', key: 'suggestion:judged-new' }))?.props['label']).toBe("Not the agent's fault")
  expect((await ui.find({ type: 'Button', key: 'dismiss:judged-new' }))?.props['label']).toBe('Hide')
  expect(await ui.find({ type: 'Button', key: 'mistake:judged-new' })).toBeUndefined()
  await ui.unmount()
})

test('an answered finding says what the answer did, in place of the buttons', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, { ...DATA, labels: { 'judged-new': 'mistake' } }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /You said: a real mistake\. It counts toward the fix below\./ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'mistake:judged-new' })).toBeUndefined()
  await ui.unmount()
})

test('wears the mark: a picture where the terminal draws one, the SVG on the desktop, else the name alone', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls, true, 'iTerm.app')
  await insights($)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props['columns']).toBe(10)
  expect(await ui.find({ type: 'Text', text: /^vibesenpai$/ })).toBeDefined()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(String((await ui.find({ type: 'Svg' }))?.props['source'] ?? '')).toMatch(/aria-label="vibesenpai"/)
  await ui.unmount()
})

test('draws no picture in a terminal that cannot show one', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls, true, 'Apple_Terminal')
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^vibesenpai$/ })).toBeDefined()
  await ui.unmount()
})

test('when the prompt box refuses, Apply puts the request on the clipboard and says so beside the button', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], refuse: 'dialog' }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'apply:16ae85' })
  expect(calls.copied).toMatch(/\(vibesenpai fix 16ae85\)$/)
  expect(await ui.find({ type: 'Text', text: /on your clipboard\. Paste it into your prompt and press Enter\./ })).toBeDefined()
  await ui.unmount()
})

test('an unanswered finding shows its dimension\'s fix above the answers, and an answer takes it away', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  await ui.press({ key: 'apply:judged-new:16ae85' })
  expect(calls.filled.at(-1)).toMatch(/\(vibesenpai fix 16ae85\)$/)
  await ui.press({ key: 'wrong:judged-new' })
  expect(await ui.find({ type: 'Button', key: 'apply:judged-new:16ae85' })).toBeUndefined()
  await ui.unmount()
})

test('Finding is wrong shows at once and records the answer', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  await ui.press({ key: 'wrong:judged-new' })
  expect(calls.argv.some((a) => a.join(' ').endsWith('label judged-new wrong'))).toBe(true)
  // No re-read after an answer: the finding stays where it is.
  expect(calls.argv.filter((a) => a.includes('--json'))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /^✓ Hidden\. Noted as a wrong finding\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /hidden: wrong finding/ })).toBeDefined()
  await ui.unmount()
})

test('Not the agent\'s fault hides the finding in place, says so, and Undo takes it back', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  await ui.press({ key: 'suggestion:judged-new' })
  expect(await ui.find({ type: 'Text', text: /^✓ Hidden\. It doesn't count against the agent\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /hidden: not the agent's fault/ })).toBeDefined()
  await ui.press({ key: 'undo:judged-new' })
  expect(calls.argv.some((a) => a.join(' ').endsWith('label judged-new --undo'))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'suggestion:judged-new' })).toBeDefined()
  await ui.unmount()
})

const EXCERPT = {
  kept: true,
  moreBefore: true,
  moreAfter: false,
  parts: [[
    { role: 'developer', at: '2026-10-29T21:12:00.000Z', cited: false, text: 'rename the command', tools: [] },
    { role: 'agent', at: '2026-10-29T21:13:00.000Z', cited: false, text: 'Renamed it to /fix.', tools: ['Edit commands/fix.md', 'Bash npm test · failed'] },
    { role: 'developer', at: '2026-10-29T21:14:00.000Z', cited: true, text: 'I want it to be /vibesenpai:fix', tools: [] },
  ]],
}

test('an open finding reads its conversation, marks the cited turn, and asks for more around it', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], excerpt: EXCERPT }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(calls.argv.some((a) => a.join(' ').includes('excerpt aaaaaaaa-1111 --turns 9 --around 3'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^▶$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^You asked:$/ }), 'the conversation replaces the quote blocks').toBeUndefined()
  // Collapsed: a line per message, tool calls as a count, no "more" yet.
  expect(await ui.find({ type: 'Text', text: /^ · 2 tool calls · 1 failed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'more:judged-new' })).toBeUndefined()
  await ui.press({ key: 'conv:judged-new' })
  expect(await ui.find({ type: 'Text', text: /^2 tool calls · 1 failed$/ })).toBeDefined()
  await ui.press({ key: 'more:judged-new' })
  expect(calls.argv.some((a) => a.join(' ').includes('--around 6'))).toBe(true)
  await ui.unmount()
})

test('once the transcript is gone, the finding keeps its quote and says so', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /no longer keeps this session's transcript/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▶$/ })).toBeUndefined()
  await ui.unmount()
})

test('an agent\'s words never pass for the developer\'s: the prompt heads the row, the quote is said to be the agent\'s', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const judged = { id: 'j-agent', at: NOW, dimension: 'misread_intent', turns: [5183], why: 'Did no work.', quote: 'No response requested.', quoteBy: 'agent' as const, asked: { seq: 5180, text: 'Alright lets continue with the fix task' } }
  engine(on, { ...DATA, sessions: [{ ...DATA.sessions[0]!, judged: [judged] }] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const label = String((await ui.find({ type: 'Button', key: 'item:new:j-agent' }))?.props['label'] ?? '')
  expect(label).toMatch(/Alright lets continue with the fix task/)
  expect(label).not.toMatch(/No response requested/)
  await ui.press({ key: 'item:new:j-agent' })
  expect(await ui.find({ type: 'Text', text: /^The agent said:$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /You asked:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'suggestion:j-agent' }), "the agent's words are not the developer's suggestion").toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'wrong:j-agent' })).toBeDefined()
  await ui.unmount()
})

test('the header carries the status on the right and a Refresh that re-reads without leaving the pane', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Reads still going and a model finding already in: the header carries the bar.
  expect(await ui.find({ type: 'Text', text: /━+ 2\/3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^updated / })).toBeDefined()
  await ui.press({ key: 'refresh-top' })
  expect(calls.argv.filter((a) => a.includes('--json'))).toHaveLength(2)
  await ui.unmount()
})

test('an open pane re-reads by itself when a background pass writes, and not otherwise', async ($, on) => {
  const clock = mock.clock(on)
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const reads = () => calls.argv.filter((a) => a.includes('--json')).length
  expect(reads()).toBe(1)
  await clock.advance(30_000)
  expect(reads()).toBe(1)
  calls.mtime = 2
  await clock.advance(30_000)
  expect(reads()).toBe(2)
})

test('before the first model finding, a card above the findings shows the reads with a real bar', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const sessions = DATA.sessions.map((x) => ({ ...x, judged: [] }))
  engine(on, { ...DATA, sessions, read: 0, total: 3, progress: { target: 3 } }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Model reads$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^0 of 3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Begins when this turn ends\.$/ })).toBeDefined()
  await ui.unmount()
})

test('while the judge runs, the card says so with the measured time and the day the limit lets it finish', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const sessions = DATA.sessions.map((x) => ({ ...x, judged: [] }))
  const finishOn = new Date(Date.now() + 3 * 86_400_000).toISOString()
  engine(on, { ...DATA, sessions, read: 1, total: 3, health: [{ job: 'judge', state: 'running' }], progress: { target: 3, seconds: 180, finishOn } }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^reading now · about 3 min$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /the rest finish \w+day\.$/ })).toBeDefined()
  await ui.unmount()
})

const barText = (runs: { text: string }[]): string => runs.map((r) => r.text).join('')

test('the bar fills from the count, with a half cell at the edge', () => {
  expect(barRuns(0, 4, 8, 0, false)).toEqual([{ tone: 'rest', text: '━━━━━━━━' }])
  expect(barRuns(2, 4, 8, 0, false)).toEqual([{ tone: 'done', text: '━━━━' }, { tone: 'rest', text: '━━━━' }])
  expect(barText(barRuns(9, 16, 8, 0, false))).toBe('━━━━╸━━━')
  expect(barRuns(4, 4, 8, 0, false)).toEqual([{ tone: 'done', text: '━━━━━━━━' }])
})

test('the glint sweeps the done part only while moving, never past the fill', () => {
  expect(barRuns(2, 4, 8, 4, false).some((r) => r.tone === 'glint')).toBe(false)
  for (let f = 0; f < 20; f++) {
    const runs = barRuns(2, 4, 8, f, true)
    expect(barText(runs)).toBe('━━━━━━━━')
    expect(runs.filter((r) => r.tone === 'rest').map((r) => r.text).join('')).toBe('━━━━')
  }
  expect(barRuns(2, 4, 8, 4, true).some((r) => r.tone === 'glint')).toBe(true)
})

test('time words round a measured estimate and name the finishing day', () => {
  expect(aboutTime(40)).toBe('about a minute')
  expect(aboutTime(180)).toBe('about 3 min')
  expect(aboutTime(3 * 3600)).toBe('about 3 h')
  const now = new Date(2026, 10, 2, 12)
  expect(finishDay(new Date(2026, 10, 3, 12).toISOString(), now)).toBe('tomorrow')
  expect(finishDay(new Date(2026, 10, 5, 12).toISOString(), now)).toBe('Thursday')
  expect(finishDay(new Date(2026, 10, 20, 12).toISOString(), now)).toBe('Nov 20')
})

/** A finding's own fix (D67): a permission for `judged-new`, applicable here unless `refusal` is set. */
const ownFix = (refusal?: string, elsewhere?: string): NonNullable<PaneData['fixes']>[number] => ({
  fixId: 'a1b2c3', dimension: 'misread_intent', target: 'project-permissions', text: 'git push', key: 'action:git push',
  destination: '.claude/settings.local.json', request: 'unused', findingIds: ['judged-new'],
  kindLine: 'Claude Code asks you before this command runs, in every mode:', whereLine: 'Added to .claude/settings.local.json',
  ...(refusal !== undefined ? { refusal } : {}),
  ...(elsewhere !== undefined ? { elsewhere } : {}),
})

test('a finding with its own fix shows that fix in place of its dimension\'s, and Apply drafts it', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, { ...DATA, fixes: [...(DATA.fixes ?? []), ownFix()] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /asks you before this command runs/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'apply:judged-new:16ae85' })).toBeUndefined()
  await ui.press({ key: 'apply:judged-new:a1b2c3' })
  expect(calls.filled.at(-1)).toMatch(/git push[\s\S]*\(vibesenpai fix a1b2c3\)$/)
  await ui.press({ key: 'tab:fixes' })
  expect(await ui.find({ type: 'Text', text: /from one finding/ })).toBeDefined()
  await ui.unmount()
})

test('a finding\'s fix from another project gives way to its kind\'s fix, which keeps Apply', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, { ...DATA, fixes: [...(DATA.fixes ?? []), ownFix(undefined, 'agentsensei')] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Button', key: 'apply:judged-new:16ae85' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /git push/ })).toBeUndefined()
  await ui.press({ key: 'tab:fixes' })
  expect(await ui.find({ type: 'Text', text: /from one finding/ })).toBeUndefined()
  await ui.unmount()
})

test('with no kind fix, a finding\'s fix from another project keeps Apply and says where it came from', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const others = (DATA.fixes ?? []).filter((f) => f.dimension !== 'misread_intent')
  engine(on, { ...DATA, fixes: [...others, ownFix(undefined, 'agentsensei')] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /Built from a session in agentsensei\. Apply adds it to this project\./ })).toBeDefined()
  await ui.press({ key: 'apply:judged-new:a1b2c3' })
  expect(calls.filled.at(-1)).toMatch(/\(vibesenpai fix a1b2c3\)$/)
  await ui.unmount()
})

test('a printed-only fix says why and offers no Apply', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const others = (DATA.fixes ?? []).filter((f) => f.dimension !== 'misread_intent')
  engine(on, { ...DATA, fixes: [...others, ownFix('A Stop hook has no Apply: it needs your paths or test command filled in, and an unfinished one would block every turn.')] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /A Stop hook has no Apply/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'apply:judged-new:a1b2c3' })).toBeUndefined()
  await ui.unmount()
})

test('a refused Apply goes to the clipboard and never names a command', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], refuse: 'no_composer' }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'apply:16ae85' })
  expect(calls.copied).toMatch(/\(vibesenpai fix 16ae85\)$/)
  expect(await ui.find({ type: 'Text', text: /so it is on your clipboard/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /vibesenpai:apply/ })).toBeUndefined()
  await ui.unmount()
})

test('when the prompt box and the clipboard both refuse, the request is shown to copy by hand', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], refuse: 'dialog', copyFails: true }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'apply:16ae85' })
  expect(await ui.find({ type: 'Text', text: /both refused it\. Copy this into your prompt:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(vibesenpai fix 16ae85\)/ })).toBeDefined()
  await ui.unmount()
})

test('Hide all hides every finding through the CLI, and Restore all on Health brings them back', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'hide-all' })
  expect(calls.argv.some((a) => a.slice(-2).join(' ') === 'dismiss --all')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^3 findings hidden\. They still count\. Restore all is on Health\.$/ })).toBeDefined()
  await ui.press({ key: 'tab:health' })
  await ui.press({ key: 'restore-all' })
  expect(calls.argv.some((a) => a.slice(-3).join(' ') === 'dismiss --undo all')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Every hidden finding is back\./ })).toBeDefined()
  await ui.unmount()
})

test('a sent fix request is recorded a few seconds after its turn ends, and the note bar says so', async ($, on) => {
  const clock = mock.clock(on)
  const calls: Calls = { argv: [], filled: [] }
  on('prompt.submit', (_, e) => ({ text: (e as { text: string }).text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  engine(on, { ...DATA, fixes: [{ ...(DATA.fixes ?? [])[0]!, applied: { at: new Date().toISOString(), sessionId: 's' }, inEffect: false }] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.prompt.submit({ text: 'Add this line to .claude/rules/vibesenpai.md …\n(vibesenpai fix 16ae85)' } as never)
  await ($ as never as { turn: { complete: (e: object) => Promise<unknown> } }).turn.complete({ answer: 'Added the line.' })
  expect(await ui.find({ type: 'Text', text: /Recording the fix you applied…/ })).toBeDefined()
  expect(calls.argv.some((a) => a.includes('standing'))).toBe(false)
  await clock.advance(5_000)
  expect(calls.argv.some((a) => a.slice(-2).join(' ') === 'standing --refresh')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /✓ Fix recorded as applied\. Rules take effect in your next session, or after \/compact\./ })).toBeDefined()
  await ui.unmount()
})

test('an applied fix with no sessions since says so in words, not as zero of zero', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  const applied = { ...(DATA.fixes ?? [])[2]!, before: { times: 0, sessions: 2 }, since: { times: 0, sessions: 0 } }
  const { cameBack: _, ...noReturn } = applied
  engine(on, { ...DATA, fixes: [noReturn] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:fixes' })
  expect(await ui.find({ type: 'Text', text: /Before 0 times in 2 sessions · Since: no sessions yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 times in 0 sessions/ })).toBeUndefined()
  await ui.unmount()
})

test('the wordmark and each ⓘ open their docs page with a plain click', async ($, on) => {
  const calls: Calls = { argv: [], filled: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const opened = () => calls.argv.filter((a) => a[0] === 'open').map((a) => a[1])

  await ui.press({ key: 'docs:header' })
  await ui.press({ key: 'docs:block:misread_intent' })
  await ui.press({ key: 'docs:block:edit_retry' })
  await ui.press({ key: 'docs:cache' })
  await ui.press({ key: 'docs:pane' })
  expect(opened()).toEqual([DOCS, `${DOCS}dimensions/misread-intent/`, `${DOCS}dimensions/edit-retry/`, `${DOCS}dimensions/cache-rebuilds/`, `${DOCS}start/pane/`])

  await ui.press({ key: 'tab:fixes' })
  await ui.press({ key: 'docs:fixes' })
  await ui.press({ key: 'docs:applied:dea0d0' })
  await ui.press({ key: 'tab:health' })
  await ui.press({ key: 'docs:health:Model reads' })
  await ui.press({ key: 'docs:health:Today' })
  expect(opened().slice(5)).toEqual([`${DOCS}start/fixes/`, `${DOCS}dimensions/overreach/`, `${DOCS}commands/judge/`, `${DOCS}start/sends-and-costs/`])
  // A link is never drawn underlined as a terminal hyperlink: it is a button.
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  await ui.unmount()
})

test('where no browser opens, the docs link is copied and the pane says so', async ($, on) => {
  const calls: Calls = { argv: [], filled: [], noOpener: true }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'docs:header' })
  expect(calls.argv.map((a) => a[0]).filter((c) => c !== 'node')).toEqual(['open', 'xdg-open'])
  expect(calls.copied).toBe(DOCS)
  expect(await ui.find({ type: 'Text', text: /the link is copied/ })).toBeDefined()
  await ui.unmount()
})

test('a dimension the docs have no page for links to the overview', () => {
  expect(dimensionDocs('redundant_call')).toBe(`${DOCS}dimensions/redundant-call/`)
  expect(dimensionDocs('something_new')).toBe(`${DOCS}dimensions/`)
})
