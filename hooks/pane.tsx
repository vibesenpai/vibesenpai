// The insights pane: new findings first, then one block per dimension, beside the chat.
// Opens only when asked (`/agentsensei:insights`); never on its own (CLAUDE.md, Principle One).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PaneData } from '../types'
import { BLOCK_SHOWN, blockCount, clip, human, view, when, words, type Item } from './shape.ts'

const PANE = 'insights'

const snapshot = atom({ plugin: 'agentsensei', key: 'snapshot' } as const, null, { shape: 'report-json-1' })
const loadedAt = atom({ plugin: 'agentsensei', key: 'loadedAt' } as const, '', { shape: 'iso-1' })
const stamp = atom({ plugin: 'agentsensei', key: 'stamp' } as const, '', { shape: 'stamp-1' })
const since = atom({ plugin: 'agentsensei', key: 'since' } as const, '', { shape: 'iso-1' })
const filter = atom({ plugin: 'agentsensei', key: 'filter' } as const, 'all', { shape: 'filter-1' })
const open = atom({ plugin: 'agentsensei', key: 'open' } as const, [], { shape: 'open-1' })
const note = atom({ plugin: 'agentsensei', key: 'note' } as const, '', { shape: 'note-1' })

/** When the person last looked: what "new" is measured from, kept across sessions. */
const SEEN_KEY = 'lastSeen'
const ENV = { NODE_NO_WARNINGS: '1' }

function cli($: EngineInterface, args: string[]): string[] {
  return ['node', '--experimental-strip-types', `${$.plugin.root}/src/cli.ts`].concat(args)
}

/** A cheap fingerprint of the files a background pass rewrites: a change means there is something new to read. */
async function fingerprint($: EngineInterface, archive: string): Promise<string> {
  const parts: string[] = []
  for (const f of ['jobs/judge.json', 'jobs/standing.json', 'standing.json']) {
    try {
      parts.push(String((await $.fs.stat(`${archive}/${f}`)).mtimeMs))
    } catch {
      parts.push('-')
    }
  }
  return parts.join(':')
}

async function load($: EngineInterface): Promise<void> {
  const r = await $.process.run(cli($, ['report', '--json']), { env: ENV, timeoutMs: 120_000 })
  if (r.exitCode !== 0) {
    await update($, note, () => `could not read the analysis: ${r.stderr.trim().split('\n').at(-1) ?? 'unknown error'}`)
    return
  }
  const data = JSON.parse(r.stdout) as PaneData
  await update($, snapshot, () => data)
  await update($, loadedAt, () => new Date().toISOString())
  const fp = await fingerprint($, data.archive)
  await update($, stamp, () => fp)
  await update($, note, () => '')
}

async function toggle($: EngineInterface, key: string): Promise<void> {
  await update($, open, (keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]))
}

async function dismiss($: EngineInterface, i: Item, wrong: boolean): Promise<void> {
  if (i.dismissId === undefined) return
  const r = await $.process.run(cli($, wrong ? ['dismiss', i.dismissId, '--wrong'] : ['dismiss', i.dismissId]), { env: ENV })
  await update($, note, () => (r.exitCode === 0 ? `Dismissed ${words(i.dimension)}${wrong ? ' as wrong' : ''}.` : 'Dismiss failed.'))
  await load($)
}

async function labelAs($: EngineInterface, i: Item, verdict: 'mistake' | 'suggestion' | 'wrong'): Promise<void> {
  if (i.dismissId === undefined) return
  const r = await $.process.run(cli($, ['label', i.dismissId, verdict]), { env: ENV })
  const said = verdict === 'mistake' ? 'a real mistake' : verdict === 'suggestion' ? 'a suggestion' : 'wrong'
  await update($, note, () => (r.exitCode === 0 ? `Marked ${words(i.dimension)} as ${said}.` : 'Could not save the label.'))
  await load($)
}

async function copy($: EngineInterface, text: string, surface: string, what: string): Promise<void> {
  const r = await $.ui.copy({ text, surface: surface as never })
  await update($, note, () => (r.isCopied ? `Copied the ${what}.` : `Could not copy the ${what}.`))
}

/** Opens the pane, reading the analysis the first time. `since` is the previous visit, so "new" means new to you. */
async function show($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'agentsensei' })
  if (!opened.isPlaced) return false
  const previous = (await $.store.get(SEEN_KEY)) as string | undefined
  await update($, since, () => previous ?? '')
  await $.store.set(SEEN_KEY, new Date().toISOString())
  await load($)
  return true
}

export const register: Register = on => {
  // The plugin's own command: open the pane where a surface draws one, else fall through to the text version.
  on('command.run', { command: 'agentsensei:insights' }, async ($, e, next) => ((await show($)) ? { text: 'Insights opened beside the chat.' } : next(e)))

  // After each turn, re-read only if a background pass changed something.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const data = (await read($, snapshot)) as PaneData | null
    if (data !== null && (await fingerprint($, data.archive)) !== ((await read($, stamp)) as string)) await load($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = (await read($, snapshot)) as PaneData | null
    const message = (await read($, note)) as string
    if (data === null) {
      return <Box flexDirection="column"><Text dimColor>{message === '' ? 'Reading your history…' : message}</Text></Box>
    }

    const width = Math.max(30, (e.props as { bodyColumns?: number }).bodyColumns ?? 60)
    const chosen = (await read($, filter)) as string
    const opened = (await read($, open)) as string[]
    const seen = (await read($, since)) as string
    const now = new Date()
    const v = view(data, seen === '' ? undefined : seen, chosen)
    const failing = data.health.filter((h) => h.state === 'retrying' || h.state === 'held')
    const updated = (await read($, loadedAt)) as string
    const mins = updated === '' ? 0 : Math.max(0, Math.round((now.getTime() - Date.parse(updated)) / 60_000))

    const where = (i: Item): string =>
      `session ${i.sessionId.slice(0, 8)} · turn${i.turns.length === 1 ? '' : 's'} ${i.turns.slice(0, 3).join(', ')}`
    const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
    // A label in bold, so a field never reads as part of the sentence before it.
    const field = (label: string, value: string, color?: string) => (
      <Text><Text weight="bold" {...(color !== undefined ? { color } : {})}>{label}: </Text>{value}</Text>
    )
    const line = (i: Item): string => i.quote !== undefined ? `“${clip(i.quote, width - 8)}”` : clip(i.subject ?? '', width - 6)

    const detail = (i: Item) => (
      <Box flexDirection="column" paddingX={2} marginTop={1} gap={0}>
        {i.asked !== undefined && flat(i.asked) !== flat(i.quote ?? '') && field('You asked', `“${clip(i.asked, width - 16)}”`)}
        {i.rows.slice(0, 4).map((r) => field(`Turn ${r.turn}`, `${r.what}${r.detail === '' ? '' : ` · ${clip(r.detail, width - 24)}`}`))}
        {i.established !== undefined && field('Established', clip(i.established, width * 2))}
        {i.why !== undefined && field('Why', i.why)}
        {i.reasons.length > 0 && field('Reasons', i.reasons.join(' · '))}
        {i.method === 'rule' && i.written > 0 && field('Cost', `${human(i.written)}+ tokens written and discarded`)}
        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          {i.dismissId !== undefined && <Button key={`mistake:${i.key}`} label="Real mistake" onPress={() => labelAs($, i, 'mistake')} />}
          {i.dismissId !== undefined && <Button key={`suggestion:${i.key}`} label="Suggestion" onPress={() => labelAs($, i, 'suggestion')} />}
          {i.dismissId !== undefined && <Button key={`wrong:${i.key}`} label="Wrong" onPress={() => labelAs($, i, 'wrong')} />}
          {i.dismissId !== undefined && <Button key={`dismiss:${i.key}`} label="Dismiss" onPress={() => dismiss($, i, false)} />}
        </Box>
      </Box>
    )

    const row = (i: Item, prefix: string) => {
      const isOpen = opened.includes(`item:${prefix}:${i.key}`)
      return (
        <Box key={`${prefix}:${i.key}`} flexDirection="column" marginTop={1}>
          <Button key={`item:${prefix}:${i.key}`} plain label={`${isOpen ? '▾' : '▸'} ${line(i)}`} onPress={() => toggle($, `item:${prefix}:${i.key}`)}>
            <Text color="warning">{`${isOpen ? '▾' : '▸'} ${line(i)}`}</Text>
          </Button>
          <Text>
            {'   '}
            {prefix === 'new' && <Text color="claude">{words(i.dimension)} · </Text>}
            {i.secondaryDimensions !== undefined && <Text color="claude">also {i.secondaryDimensions.map(words).join(', ')} · </Text>}
            <Text color={i.method === 'model' ? 'planMode' : 'success'}>{i.method === 'model' ? 'flagged by a model' : 'flagged by rule'}</Text>
            <Text dimColor> · {when(i.at, now)} · {where(i)}</Text>
            {i.dismissId !== undefined && data.labels?.[i.dismissId] !== undefined && <Text color="success"> · you said: {data.labels[i.dismissId] === 'mistake' ? 'real mistake' : data.labels[i.dismissId]}</Text>}
          </Text>
          {isOpen && detail(i)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="bold">{data.read}/{data.total} sessions read <Text dimColor>· updated {mins === 0 ? 'just now' : `${mins}m ago`}</Text></Text>
          {failing.map((h) => <Text>! {h.job === 'judge' ? 'The judge' : 'The history pass'} is {h.state}: {h.reason ?? 'reason unknown'}</Text>)}
          {message !== '' && <Text dimColor>{message}</Text>}
        </Box>

        {v.newItems.length > 0 && (
          <Box flexDirection="column">
            <Text weight="bold" color="claude">New since you last looked · {v.newItems.length}</Text>
            {v.newItems.map((i) => row(i, 'new'))}
          </Box>
        )}

        <Box flexDirection="row" gap={1}>
          {[['all', 'All'], ['model', 'By a model'], ['rule', 'By rule']].map(([k, label]) => (
            <Button key={`filter:${k}`} label={label as string} variant={chosen === k ? 'primary' : 'secondary'} onPress={() => update($, filter, () => k as string)} />
          ))}
        </Box>

        {v.blocks.length === 0 && <Text dimColor>Nothing flagged yet.</Text>}

        {v.blocks.map((b) => {
          // The first block starts open; every block, the first included, toggles.
          const first = b === v.blocks[0]
          const toggleKey = first ? `closed:${b.dimension}` : `block:${b.dimension}`
          const isOpen = first ? !opened.includes(toggleKey) : opened.includes(toggleKey)
          const all = opened.includes(`all:${b.dimension}`)
          const shown = all ? b.items : b.items.slice(0, BLOCK_SHOWN)
          return (
            <Box key={`block:${b.dimension}`} flexDirection="column">
              <Button key={`block:${b.dimension}`} plain label={`${isOpen ? '▾' : '▸'} ${words(b.dimension)} · ${blockCount(b)} in ${b.sessions} session${b.sessions === 1 ? '' : 's'}`} onPress={() => toggle($, toggleKey)}>
                <Text weight="bold" color="claude">{isOpen ? '▾' : '▸'} {words(b.dimension)}</Text>
                <Text dimColor> · {blockCount(b)} in {b.sessions} session{b.sessions === 1 ? '' : 's'}</Text>
              </Button>
              {isOpen && <Box flexDirection="column" paddingX={2}>{shown.map((i) => row(i, b.dimension))}</Box>}
              {isOpen && !all && b.items.length > BLOCK_SHOWN && (
                <Button key={`all:${b.dimension}`} plain label={`   … ${b.items.length - BLOCK_SHOWN} more`} onPress={() => toggle($, `all:${b.dimension}`)} />
              )}
              {isOpen && b.fix !== undefined && (
                <Box flexDirection="column" paddingX={2} marginTop={1}>
                  {b.fix.prompt !== undefined && field('Fix', b.fix.prompt.replace(/^For the rest of this session:\s*/i, ''), 'success')}
                  <Box flexDirection="row" gap={1} marginTop={1}>
                    {b.fix.prompt !== undefined && <Button key={`copy-prompt:${b.dimension}`} label="Copy prompt" onPress={(p) => copy($, b.fix?.prompt ?? '', p.surface, 'prompt')} />}
                    {b.fix.memory !== undefined && b.fix.memory !== '' && <Button key={`copy-memory:${b.dimension}`} label="Copy CLAUDE.md line" onPress={(p) => copy($, b.fix?.memory ?? '', p.surface, 'CLAUDE.md line')} />}
                    {b.fix.config !== undefined && <Button key={`copy-config:${b.dimension}`} label="Copy config" onPress={(p) => copy($, b.fix?.config?.snippet ?? '', p.surface, 'config')} />}
                  </Box>
                </Box>
              )}
            </Box>
          )
        })}

        {v.cache.count > 0 && (
          <Box flexDirection="column">
            <Button key="block:cache" plain label={`${opened.includes('block:cache') ? '▾' : '▸'} ! cache · ${v.cache.count} rebuild${v.cache.count === 1 ? '' : 's'} · ${human(v.cache.tokens)} tokens written again`} onPress={() => toggle($, 'block:cache')} />
            {opened.includes('block:cache') && v.cache.largest.map((r) => (
              <Text dimColor>     turn {r.seq} · {r.sessionId.slice(0, 8)}{r.gapMinutes !== undefined ? ` · ${Math.round(r.gapMinutes)} min after the previous request` : ''} · {r.tokens.toLocaleString('en-US')} cache write</Text>
            ))}
          </Box>
        )}

        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" onPress={() => load($)} />
          <Button key="report" label="Open full report" onPress={async () => { await $.process.run(cli($, ['report', '--html', '--open']), { env: ENV, timeoutMs: 120_000 }) }} />
        </Box>
      </Box>
    )
  })
}
