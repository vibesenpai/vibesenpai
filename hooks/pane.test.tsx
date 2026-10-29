// The insights pane, against a stubbed engine and a stubbed `agentsensei report --json`.
import { expect, test, type TestBody } from 'claude-code/testing'

import type { PaneData } from '../types'

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
        { id: 'judged-new', at: NOW, dimension: 'misread_intent', secondaryDimensions: ['overreach'], turns: [9], why: 'Kept the plain name.', quote: 'I want it to be /agentsensei:fix', asked: { seq: 8, text: 'rename the command' }, established: 'turn 3 — “call it /agentsensei:fix”' },
      ],
      stats: { rebuilds: { count: 1, tokens: 120_000, events: [{ seq: 30, tokens: 120_000, cached: 140_000, gapMinutes: 75 }] } },
    },
  ],
}

const PANE = {
  plugin: 'agentsensei',
  component: 'Pane',
  requestId: 'insights',
  props: { title: 'agentsensei', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Calls = { argv: string[][] }

/** Run `/agentsensei:insights`; the kit fills the fields a typed command carries. */
const insights = ($: Parameters<TestBody>[0]) => $.command.run({ command: 'agentsensei:insights' } as never)

/** The engine beneath the plugin: a placed pane, a store that last saw us in the past, and our CLI answering. */
function engine(on: Parameters<TestBody>[1], data: PaneData | null, calls: Calls, isPlaced = true, onCopy?: (text: string) => void): void {
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no room' } }))
  on('store.get', () => ({ value: '2026-10-10T00:00:00.000Z' }))
  on('store.set', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('ui.copy', (_, e) => {
    onCopy?.((e as { text: string }).text)
    return { value: { isCopied: true } }
  })
  on('process.run', (_, e) => {
    calls.argv.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: data === null ? '' : JSON.stringify(data), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: 'the text version' }))
}

test('opens on the command, reads the analysis, and shows new findings first', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, DATA, calls)
  const r = await insights($)
  expect(r.text).toBe('Insights opened beside the chat.')
  expect(calls.argv[0]?.slice(-2)).toEqual(['report', '--json'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /2\/3 sessions read/ }))?.text).toMatch(/2\/3 sessions read/)
    expect((await ui.find({ type: 'Text', text: /New since you last looked · 1/ }))?.text).toBeDefined()
    // The old finding is not new; the method is always stated.
    expect(await ui.find({ type: 'Text', text: /flagged by a model/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /also overreach/ })).toBeDefined()
    await ui.unmount()
  }
})

test('falls through to the text version where no pane can be placed', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, DATA, calls, false)
  const r = await insights($)
  expect(r.text).toBe('the text version')
  expect(calls.argv).toHaveLength(0)
})

test('a finding expands to its turns and reason, and Dismiss calls the CLI with its id', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'item:new:judged-new' })
  expect(await ui.find({ type: 'Text', text: /You asked: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rename the command/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Why: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Kept the plain name/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /call it \/agentsensei:fix/ })).toBeDefined()

  await ui.press({ key: 'dismiss:judged-new' })
  expect(calls.argv.some((a) => a.includes('dismiss') && a.includes('judged-new'))).toBe(true)
  await ui.unmount()
})

test('the fix copies its prompt', async ($, on) => {
  const calls: Calls = { argv: [] }
  let copied = ''
  engine(on, DATA, calls, true, (t) => {
    copied = t
  })
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'copy-prompt:misread_intent' })
  expect(copied).toMatch(/before acting on anything ambiguous/)
  await ui.unmount()
})

test('an empty history says so instead of throwing', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, { ...DATA, sessions: [], recommendations: {}, read: 0, total: 0 }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nothing flagged yet/ }))?.text).toBe('Nothing flagged yet.')
  await ui.unmount()
})

test('a narrow pane clips quotes rather than overflowing', async ($, on) => {
  const calls: Calls = { argv: [] }
  const long = 'x'.repeat(200)
  engine(on, { ...DATA, sessions: [{ ...DATA.sessions[0]!, judged: [{ id: 'j', at: NOW, dimension: 'misread_intent', turns: [1], why: 'w', quote: long }] }] }, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  const label = String((await ui.find({ type: 'Button', key: 'item:new:j' }))?.props['label'] ?? '')
  expect(label).toMatch(/…/)
  expect(label.length).toBeLessThan(40)
  await ui.unmount()
})

test('a block shows the problem before the fix, and the fix in full', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = JSON.stringify(await ui.find({ type: 'Box' }))
  expect(texts.indexOf('I want it to be')).toBeLessThan(texts.indexOf('Fix: '))
  expect(await ui.find({ type: 'Text', text: /state the request\./ })).toBeDefined()
  await ui.unmount()
})


test('the first block starts open and collapses when pressed', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = DATA.sessions[0]!.judged[0]!.dimension
  expect(await ui.find({ type: 'Text', text: /Fix: / })).toBeDefined()
  await ui.press({ key: `block:${first}` })
  expect(await ui.find({ type: 'Text', text: /Fix: / })).toBeUndefined()
  await ui.press({ key: `block:${first}` })
  expect(await ui.find({ type: 'Text', text: /Fix: / })).toBeDefined()
  await ui.unmount()
})

test('Suggestion records a label with the CLI', async ($, on) => {
  const calls: Calls = { argv: [] }
  engine(on, DATA, calls)
  await insights($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item:new:judged-new' })
  await ui.press({ key: 'suggestion:judged-new' })
  expect(calls.argv.some((a) => a.join(' ').endsWith('label judged-new suggestion'))).toBe(true)
  await ui.unmount()
})
