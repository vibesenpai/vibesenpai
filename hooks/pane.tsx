// The insights pane: findings, the fixes for them, and job health, in three tabs beside the chat.
// Opens only when asked (`/agentsensei:insights`); never on its own (CLAUDE.md, Principle One).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PaneData, PaneExcerpt, PaneExcerptEntry, PaneFixState } from '../types'
import { BLOCK_SHOWN, blockCount, clip, clock, costNote, fixKind, shortDay, spendText, wrapLines, fixWhere, fixWords, fixesView, human, tabStrip, timesIn, view, when, windowText, words, type Item } from './shape.ts'
import { applyRequest } from '../src/harness/claude-code.ts'
import { MARK_PNG, MARK_SVG } from './logo.ts'

const PANE = 'insights'

const snapshot = atom({ plugin: 'agentsensei', key: 'snapshot' } as const, null, { shape: 'report-json-1' })
const loadedAt = atom({ plugin: 'agentsensei', key: 'loadedAt' } as const, '', { shape: 'iso-1' })
const stamp = atom({ plugin: 'agentsensei', key: 'stamp' } as const, '', { shape: 'stamp-1' })
const since = atom({ plugin: 'agentsensei', key: 'since' } as const, '', { shape: 'iso-1' })
const tab = atom({ plugin: 'agentsensei', key: 'tab' } as const, 'findings', { shape: 'tab-1' })
const picked = atom({ plugin: 'agentsensei', key: 'picked' } as const, [], { shape: 'picked-1' })
const open = atom({ plugin: 'agentsensei', key: 'open' } as const, [], { shape: 'open-1' })
const ticked = atom({ plugin: 'agentsensei', key: 'ticked' } as const, 0, { shape: 'ticked-1' })
const busy = atom({ plugin: 'agentsensei', key: 'busy' } as const, false, { shape: 'busy-1' })
const answered = atom({ plugin: 'agentsensei', key: 'answered' } as const, {}, { shape: 'answered-1' })
const applied = atom({ plugin: 'agentsensei', key: 'applied' } as const, {}, { shape: 'applied-1' })
const drafted = atom({ plugin: 'agentsensei', key: 'drafted' } as const, [], { shape: 'drafted-1' })
const pictures = atom({ plugin: 'agentsensei', key: 'pictures' } as const, false, { shape: 'pictures-1' })
const note = atom({ plugin: 'agentsensei', key: 'note' } as const, '', { shape: 'note-1' })
const excerpts = atom({ plugin: 'agentsensei', key: 'excerpts' } as const, {}, { shape: 'excerpts-1' })

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
  let data: PaneData
  try {
    data = JSON.parse(r.stdout) as PaneData
  } catch {
    await update($, note, () => (r.isStdoutTruncated ? 'The analysis was too large to read.' : 'Could not read the analysis.'))
    return
  }
  await update($, snapshot, () => data)
  await update($, loadedAt, () => new Date().toISOString())
  const fp = await fingerprint($, data.archive)
  await update($, stamp, () => fp)
  await update($, note, () => '')
}

/** Re-reads the analysis, saying so meanwhile; answers given here are now in the data, so they are dropped. */
async function refresh($: EngineInterface): Promise<void> {
  await update($, busy, () => true)
  try {
    await load($)
    await update($, answered, () => ({}))
  } finally {
    await update($, busy, () => false)
  }
}

async function toggle($: EngineInterface, key: string): Promise<void> {
  await update($, open, (keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]))
}

/** Messages either side of a cited turn, first asked for and then per "more". */
const AROUND = 3

/** Reads the conversation around a finding from its transcript; held in session state, never stored. */
async function fetchExcerpt($: EngineInterface, i: Item, around: number): Promise<void> {
  if (i.turns.length === 0) return
  await update($, excerpts, (m) => ({ ...m, [i.key]: { ...m[i.key], around } }))
  const r = await $.process.run(cli($, ['excerpt', i.sessionId, '--turns', i.turns.join(','), '--around', String(around)]), { env: ENV })
  let excerpt: PaneExcerpt = { kept: false }
  try {
    if (r.exitCode === 0) excerpt = JSON.parse(r.stdout) as PaneExcerpt
  } catch {
    return
  }
  await update($, excerpts, (m) => ({ ...m, [i.key]: { around, excerpt } }))
}

/** Opens a finding, reading its conversation the first time. */
async function openItem($: EngineInterface, key: string, i: Item): Promise<void> {
  const opening = !((await read($, open)) as string[]).includes(key)
  await toggle($, key)
  if (opening && ((await read($, excerpts)) as Record<string, unknown>)[i.key] === undefined) await fetchExcerpt($, i, AROUND)
}

/** An answer given in this pane, shown at once; the CLI records it behind. `hidden` is Hide. */
type Answer = 'mistake' | 'suggestion' | 'wrong' | 'hidden'

async function dismiss($: EngineInterface, i: Item): Promise<void> {
  if (i.dismissId === undefined) return
  const id = i.dismissId
  await update($, answered, (m) => ({ ...m, [id]: 'hidden' as const }))
  const r = await $.process.run(cli($, ['dismiss', id]), { env: ENV })
  if (r.exitCode !== 0) await update($, answered, (m) => { const { [id]: _, ...rest } = m; return rest })
}

/** Rules files are read when a session starts or compacts; no command reloads them (checked 2026-10-29). */
const LOADS = 'Rules load when a session starts, so it takes effect in your next session, or after /compact.'

/** What an answer did, said where the buttons were (and in the note, once a hidden finding is gone). */
const SAID: Record<Answer, string> = {
  mistake: 'You said: a real mistake. It counts toward the fix below.',
  suggestion: "Hidden. It doesn't count against the agent.",
  wrong: 'Hidden. Noted as a wrong finding.',
  hidden: 'Hidden. It still counts.',
}

async function labelAs($: EngineInterface, i: Item, verdict: 'mistake' | 'suggestion' | 'wrong'): Promise<void> {
  if (i.dismissId === undefined) return
  const id = i.dismissId
  // Shown first, recorded after: the CLI takes about a second, and the finding stays in place until the next read.
  await update($, answered, (m) => ({ ...m, [id]: verdict }))
  const r = await $.process.run(cli($, ['label', id, verdict]), { env: ENV })
  if (r.exitCode !== 0) {
    await update($, answered, (m) => { const { [id]: _, ...rest } = m; return rest })
    await update($, note, () => 'Could not save the answer.')
  }
}

/** Takes an answer or a Hide back, then re-reads so the finding is counted again. */
async function undo($: EngineInterface, i: Item, was: Answer): Promise<void> {
  if (i.dismissId === undefined) return
  const id = i.dismissId
  await update($, answered, (m) => { const { [id]: _, ...rest } = m; return rest })
  await $.process.run(cli($, was === 'hidden' ? ['dismiss', '--undo', id] : ['label', id, '--undo']), { env: ENV })
  await load($)
}

/**
 * Drafts the request into the prompt box; the person's Enter is the yes. Never over a draft they typed,
 * never sent from here: the agent makes the change with the harness's own permission prompt.
 */
async function apply($: EngineInterface, fixes: PaneFixState[]): Promise<void> {
  if (fixes.length === 0) return
  const ids = fixes.map((f) => f.fixId)
  // Said beside the button that was pressed: a note at the top of the pane is off screen down here.
  const say = (text: string) => update($, applied, (m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, text])) }))
  try {
    const box = await $.prompt.read()
    if (box.text.trim() !== '') {
      await say('Your prompt box has a draft. Clear it, then press Apply again.')
      return
    }
    const text = applyRequest(fixes)
    const r = await $.prompt.fill({ text, mode: 'replace' })
    if (r.isFilled) {
      await update($, drafted, (d) => [...new Set([...d, ...ids])])
      await say('')
    } else if (r.refusal === 'no_composer') {
      await say('There is no prompt box here. Run /agentsensei:apply instead.')
    } else {
      // The pane may hold the keyboard after a click; the clipboard still gets the request to the prompt.
      const c = await $.ui.copy({ text })
      await say(c.isCopied
        ? 'The prompt box would not take it, so it is on your clipboard. Paste it into your prompt and press Enter.'
        : `The prompt box would not take it${r.refusal !== undefined ? ` (${r.refusal})` : ''}. Run /agentsensei:apply instead.`)
    }
  } catch (err) {
    await say(`Apply failed: ${err instanceof Error ? err.message : String(err)}. Run /agentsensei:apply instead.`)
  }
  await update($, picked, () => [])
}

/** Terminals that draw pictures (kitty's or iTerm2's protocol); tmux passes neither through. */
function drawsPictures(program: string | undefined, term: string | undefined, tmux: string | undefined): boolean {
  if (tmux !== undefined && tmux !== '') return false
  return ['iTerm.app', 'ghostty', 'WezTerm'].includes(program ?? '') || /kitty|ghostty/.test(term ?? '')
}

/** How often an open pane checks whether a background pass wrote something new. Three file stats, no CLI. */
const AUTO_REFRESH_MS = 30_000

let ticker: { cancel: () => void } | undefined

/** Re-reads only when the passes' files changed; otherwise just moves "updated Xm ago" on. */
function autoRefresh($: EngineInterface): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(AUTO_REFRESH_MS, async () => {
    try {
      const data = (await read($, snapshot)) as PaneData | null
      if (data !== null && !((await read($, busy)) as boolean) && (await fingerprint($, data.archive)) !== ((await read($, stamp)) as string)) {
        await refresh($)
      }
      await update($, ticked, (n) => n + 1)
    } catch {
      // A missed check is caught by the next one.
    }
  })
}

/** Opens the pane, reading the analysis the first time. `since` is the previous visit, so "new" means new to you. */
async function show($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'agentsensei' })
  if (!opened.isPlaced) return false
  // A guess about the terminal must never keep the pane from opening.
  const draws = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('TERM'), $.env.get('TMUX')])
    .then(([program, term, tmux]) => drawsPictures(program, term, tmux))
    .catch(() => false)
  await update($, pictures, () => draws)
  const previous = (await $.store.get(SEEN_KEY)) as string | undefined
  await update($, since, () => previous ?? '')
  await $.store.set(SEEN_KEY, new Date().toISOString())
  await load($)
  autoRefresh($)
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
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const data = (await read($, snapshot)) as PaneData | null
    const message = (await read($, note)) as string
    if (data === null) {
      return <Box flexDirection="column"><Text dimColor>{message === '' ? 'Reading your history…' : message}</Text></Box>
    }

    const width = Math.max(30, (e.props as { bodyColumns?: number }).bodyColumns ?? 60)
    const active = (await read($, tab)) as string
    const opened = (await read($, open)) as string[]
    const picks = (await read($, picked)) as string[]
    const seen = (await read($, since)) as string
    const now = new Date()
    const failing = data.health.filter((h) => h.state === 'retrying' || h.state === 'held')
    const updated = (await read($, loadedAt)) as string
    const refreshing = (await read($, busy)) as boolean
    // Read so the clock's tick redraws the age of the data.
    await read($, ticked)
    const mins = updated === '' ? 0 : Math.max(0, Math.round((now.getTime() - Date.parse(updated)) / 60_000))

    const isOpen = (key: string): boolean => opened.includes(key)
    const caret = (key: string): string => (isOpen(key) ? '▾' : '▸')
    const title = (d: string): string => { const w = words(d); return w.charAt(0).toUpperCase() + w.slice(1) }
    const day = shortDay
    const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const field = (label: string, value: string) => (
      <Text><Text weight="bold">{label}: </Text>{value}</Text>
    )
    // Anything someone typed or will send, drawn as a prompt: the prompt box's border colour as a bar, then italic text.
    // Wrapped here so the bar starts every line; `room` is the columns left after the indents around it.
    const prompt = (text: string, room: number) => (
      <Box flexDirection="column" marginY={1}>
        {wrapLines(text, Math.max(16, room - 2)).map((l) => (
          <Text><Text color="promptBorder">▎ </Text><Text italic mono color="suggestion">{l}</Text></Text>
        ))}
      </Box>
    )
    // A label column, so a wrapped value keeps its indent.
    const labelled = (label: string, color: string | undefined, body: unknown) => (
      <Box flexDirection="row">
        <Box width={6} flexShrink={0}><Text weight="bold" {...(color !== undefined ? { color } : {})}>{label}</Text></Box>
        <Box flexDirection="column" flexShrink={1}>{body as never}</Box>
      </Box>
    )

    const answers = (await read($, answered)) as Record<string, Answer>
    const answerOf = (i: Item): Answer | undefined => (i.dismissId === undefined ? undefined : answers[i.dismissId] ?? data.labels?.[i.dismissId])
    const fixFor = (i: Item) => data.fixes?.find((f) => f.dimension === i.dimension)
    // What an answer did, in place, with Undo. A finding marked a mistake keeps its fix.
    const answerResult = (i: Item, a: Answer) => {
      const fix = fixFor(i)
      return (
        <Box flexDirection="column">
          <Text color="success">✓ {SAID[a]}</Text>
          {a === 'mistake' && fix !== undefined && <Box marginTop={1}>{fixSection(fix, `${i.key}:`)}</Box>}
          <Box marginTop={1}>
            <Button key={`undo:${i.key}`} plain label="Undo" onPress={() => undo($, i, a)}><Text dimColor underline>Undo</Text></Button>
          </Box>
        </Box>
      )
    }

    const shown = (await read($, excerpts)) as Record<string, { around: number; excerpt?: PaneExcerpt }>
    // Markdown marks read as noise in a pane.
    const plain = (t: string): string => flat(t.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, ''))
    const toolCount = (m: PaneExcerptEntry): string => {
      if (m.tools.length === 0) return ''
      const failed = m.tools.filter((t) => t.endsWith(' · failed')).length
      return `${m.tools.length} tool call${m.tools.length === 1 ? '' : 's'}${failed > 0 ? ` · ${failed} failed` : ''}`
    }
    // Who, when and ▶ in fixed columns; the pane wraps or cuts the text, never us.
    const turnLine = (m: PaneExcerptEntry, k: string, full: boolean) => {
      const mine = m.role === 'developer'
      const text = plain(m.text)
      const body = full ? clip(text, m.cited ? 480 : 200) : text
      const content = mine
        ? <Text italic mono color="suggestion" wrap={full ? 'wrap' : 'truncate-end'}>{full ? body : `▎ ${body}`}</Text>
        : <Text wrap={full ? 'wrap' : 'truncate-end'}>{body}</Text>
      const tools = toolCount(m)
      return (
        <Box key={k} flexDirection="row">
          <Box width={2} flexShrink={0}><Text color="claude">{m.cited ? '▶' : ' '}</Text></Box>
          <Box width={6} flexShrink={0}><Text weight="bold">{mine ? 'You' : 'Agent'}</Text></Box>
          <Box width={9} flexShrink={0}><Text dimColor>{m.at !== undefined ? clock(m.at) : ''}</Text></Box>
          {full
            ? (
              <Box flexDirection="column" flexShrink={1}>
                {text !== '' && content}
                {tools !== '' && <Text dimColor>{tools}</Text>}
              </Box>
            )
            : (
              <Box flexDirection="row" flexShrink={1}>
                <Box flexShrink={1}>{text !== '' ? content : <Text dimColor>{tools}</Text>}</Box>
                {text !== '' && tools !== '' && <Box flexShrink={0}><Text dimColor> · {tools}</Text></Box>}
              </Box>
            )}
        </Box>
      )
    }
    // Collapsed: each cited message and its neighbours, a line each. Expanded: the whole excerpt.
    const conversation = (i: Item, x: { around: number; excerpt: PaneExcerpt & { kept: true } }) => {
      const key = `conv:${i.key}`
      const full = isOpen(key)
      const parts = full ? x.excerpt.parts : x.excerpt.parts.map((part) => part.filter((_, n) => part.slice(Math.max(0, n - 1), n + 2).some((m) => m.cited)))
      return (
        <Box flexDirection="column" gap={full ? 1 : 0}>
          {parts.map((part, p) => (
            <Box key={`part:${i.key}:${p}`} flexDirection="column" gap={full ? 1 : 0}>
              {p > 0 && <Text dimColor>  ···</Text>}
              {part.map((m, n) => turnLine(m, `msg:${i.key}:${p}:${n}`, full))}
            </Box>
          ))}
          <Box flexDirection="row" gap={2} marginTop={full ? 0 : 1}>
            {full && (x.excerpt.moreBefore || x.excerpt.moreAfter) && (
              <Button key={`more:${i.key}`} plain label="More around this" onPress={() => fetchExcerpt($, i, x.around + AROUND)}><Text dimColor underline>More around this</Text></Button>
            )}
            <Button key={key} plain label={full ? 'Hide conversation' : 'Show conversation'} onPress={() => toggle($, key)}>
              <Text dimColor underline>{full ? 'Hide conversation' : 'Show conversation ▸'}</Text>
            </Button>
          </Box>
        </Box>
      )
    }
    // Until the conversation is read, and once the harness has deleted it: the words we keep.
    const kept = (i: Item) => (
      <Box flexDirection="column" gap={1}>
        {!headline(i).asked && i.asked !== undefined && flat(i.asked) !== flat(i.quote ?? '') && (
          <Box flexDirection="column"><Text weight="bold">You asked:</Text>{prompt(clip(i.asked, width * 3), width - 10)}</Box>
        )}
        {headline(i).asked && i.quote !== undefined && (
          <Box flexDirection="column">
            <Text weight="bold">{i.quoteBy === 'agent' ? 'The agent said:' : 'Quoted:'}</Text>
            <Text>“{clip(i.quote, width * 3)}”</Text>
          </Box>
        )}
        {shown[i.key]?.excerpt?.kept === false && <Text dimColor>Claude Code no longer keeps this session's transcript.</Text>}
      </Box>
    )

    const detail = (i: Item) => {
      const x = shown[i.key]
      return (
      <Box flexDirection="column" paddingLeft={2} marginTop={1} gap={1}>
        {x?.excerpt?.kept === true ? conversation(i, { around: x.around, excerpt: x.excerpt }) : kept(i)}
        {i.rows.length > 0 && <Box flexDirection="column">{i.rows.slice(0, 4).map((r) => field(r.ts !== undefined ? clock(r.ts) : `Turn ${r.turn}`, `${r.what}${r.detail === '' ? '' : ` · ${clip(r.detail, width - 24)}`}`))}</Box>}
        {i.established !== undefined && field('Established', clip(i.established, width * 2))}
        {i.why !== undefined && field('Why', i.why)}
        {i.reasons.length > 0 && field('Reasons', i.reasons.join(' · '))}
        {i.method === 'rule' && i.written > 0 && field('Cost', `${human(i.written)}+ tokens written and discarded`)}
        {i.dismissId !== undefined && (answerOf(i) !== undefined
          ? answerResult(i, answerOf(i) as Answer)
          : (
            // No answer means the finding stands, so its fix shows. "Not the agent's fault" only when the quote is the developer's.
            <Box flexDirection="column" gap={1}>
              {fixFor(i) !== undefined && fixSection(fixFor(i)!, `${i.key}:`)}
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Button key={`wrong:${i.key}`} label="Finding is wrong" onPress={() => labelAs($, i, 'wrong')} />
                {i.quote !== undefined && i.quoteBy === 'developer' && (
                  <Button key={`suggestion:${i.key}`} label="Not the agent's fault" onPress={() => labelAs($, i, 'suggestion')} />
                )}
                <Box marginLeft={2}>
                  <Button key={`dismiss:${i.key}`} plain label="Hide" onPress={() => dismiss($, i)}><Text dimColor underline>Hide</Text></Button>
                </Box>
              </Box>
            </Box>
          ))}
      </Box>
      )
    }

    // A time the developer can place, where the transcript gives one; else the turn numbers.
    const where = (i: Item, withSession: boolean): string =>
      [when(i.turnAt ?? i.at, now), ...(withSession ? [`session ${i.sessionId.slice(0, 8)}`] : []),
        i.turnAt !== undefined ? clock(i.turnAt) : `turn${i.turns.length === 1 ? '' : 's'} ${i.turns.slice(0, 3).join(', ')}`].join(' · ')
    // The row's headline is the developer's own words: their quote, else the prompt the turn answered.
    // The agent's words are never drawn as a prompt.
    const headline = (i: Item): { text: string; mine: boolean; asked: boolean } =>
      i.quote !== undefined && i.quoteBy === 'developer' ? { text: i.quote, mine: true, asked: false }
        : i.asked !== undefined ? { text: i.asked, mine: true, asked: true }
          : { text: i.quote ?? i.subject ?? '', mine: false, asked: false }
    const said = (i: Item): string => { const h = headline(i); return h.mine || i.quote !== undefined ? `“${clip(h.text, width - 8)}”` : clip(h.text, width - 6) }

    const row = (i: Item, prefix: string, isNew: boolean) => {
      const key = `item:${prefix}:${i.key}`
      const label = answerOf(i)
      return (
        <Box key={`${prefix}:${i.key}`} flexDirection="column" marginTop={1}>
          <Button key={key} plain label={`${caret(key)} ${said(i)}`} onPress={() => openItem($, key, i)}>
            <Text>{caret(key)} {headline(i).mine ? <Text italic mono color="suggestion">{said(i)}</Text> : said(i)}</Text>
          </Button>
          <Text>
            {'  '}
            {isNew && <Text color="claude">{title(i.dimension)} · </Text>}
            {i.secondaryDimensions !== undefined && <Text color="claude">also {i.secondaryDimensions.map(words).join(', ')} · </Text>}
            <Text dimColor>{where(i, !isNew)}</Text>
            {label !== undefined && <Text color="success"> · {label === 'mistake' ? 'you said: real mistake' : label === 'hidden' ? 'hidden' : `hidden: ${label === 'wrong' ? 'wrong finding' : "not the agent's fault"}`}</Text>}
          </Text>
          {isOpen(key) && detail(i)}
        </Box>
      )
    }

    const draftedIds = (await read($, drafted)) as string[]
    const outcome = (await read($, applied)) as Record<string, string>
    const outcomeLine = (f: PaneFixState) => outcome[f.fixId] !== undefined && outcome[f.fixId] !== '' && <Text color="suggestion">{outcome[f.fixId]}</Text>
    const requested = (f: PaneFixState) => f.applied !== undefined && f.inEffect === false && <Text dimColor>Requested {day(f.applied.at)} · not in effect yet: rules load in a new session, or after /compact</Text>
    // Once pressed, a fix folds to one line saying how far it got: drafted, requested, applied.
    const fixDone = (f: PaneFixState): string | undefined =>
      f.applied !== undefined && f.inEffect !== false ? `Fix applied ${day(f.applied.at)}`
        : f.applied !== undefined ? `Fix requested ${day(f.applied.at)} · not in effect yet: rules load in a new session, or after /compact`
          : draftedIds.includes(f.fixId) ? 'Fix drafted in your prompt box. Press Enter to apply it.'
            : undefined
    // `scope` keeps keys unique when a finding repeats its dimension's fix.
    const fixSection = (f: PaneFixState, scope = '') => {
      const done = fixDone(f)
      if (done !== undefined) {
        return (
          <Box flexDirection="column">
            <Text color="success">✓ {done}</Text>
            {f.applied === undefined && f.target === 'project-instructions' && <Text dimColor>{LOADS}</Text>}
            {/* Requested but never loaded may have been declined, so it can be asked for again. */}
            {f.applied !== undefined && f.inEffect === false && (
              <Button key={`apply:${scope}${f.fixId}`} plain label="Apply again" onPress={() => apply($, [f])}><Text dimColor underline>Apply again</Text></Button>
            )}
          </Box>
        )
      }
      return labelled('Fix', 'suggestion', [
        <Text dimColor>{fixKind(f)}</Text>,
        prompt(fixWords(f), width - 10),
        <Text dimColor>{fixWhere(f)}</Text>,
        <Box marginTop={1}><Button key={`apply:${scope}${f.fixId}`} variant="primary" label="Apply" onPress={() => apply($, [f])} /></Box>,
        outcomeLine(f),
      ])
    }

    const findingsTab = () => {
      const v = view(data, seen === '' ? undefined : seen)
      return (
        <Box flexDirection="column" gap={1}>
          {v.newItems.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">New since you last looked</Text>
              {v.newItems.map((i) => row(i, 'new', true))}
            </Box>
          )}
          {v.blocks.length === 0 && <Text dimColor>Nothing flagged in {data.read} sessions read.</Text>}
          {v.blocks.map((b) => {
            // The first block starts open; every block, the first included, toggles.
            const first = b === v.blocks[0]
            const key = first ? `closed:${b.dimension}` : `block:${b.dimension}`
            const shown = first ? !isOpen(key) : isOpen(key)
            const list = `list:${b.dimension}`
            const all = isOpen(`all:${b.dimension}`)
            const items = all ? b.items : b.items.slice(0, BLOCK_SHOWN + 1)
            return (
              <Box key={`block:${b.dimension}`} flexDirection="column" marginTop={1}>
                <Button key={`block:${b.dimension}`} plain label={`${shown ? '▾' : '▸'} ${title(b.dimension)}`} onPress={() => toggle($, key)}>
                  <Text weight="bold" color="claude">{shown ? '▾' : '▸'} {title(b.dimension)}</Text>
                </Button>
                <Text dimColor>  {timesIn(blockCount(b), b.sessions)}</Text>
                {shown && (
                  <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                    <Button key={list} plain label={`${caret(list)} ${b.items.length} finding${b.items.length === 1 ? '' : 's'}`} onPress={() => toggle($, list)}>
                      <Text dimColor>{caret(list)} {b.items.length} finding{b.items.length === 1 ? '' : 's'}</Text>
                    </Button>
                    {isOpen(list) && <Box flexDirection="column" paddingLeft={2}>{items.map((i) => row(i, b.dimension, false))}</Box>}
                    {isOpen(list) && !all && b.items.length > items.length && (
                      <Button key={`all:${b.dimension}`} plain label={`    … ${b.items.length - items.length} more`} onPress={() => toggle($, `all:${b.dimension}`)} />
                    )}
                  </Box>
                )}
                {shown && b.fix !== undefined && (
                  <Box paddingLeft={2} marginTop={1}>{fixSection(b.fix)}</Box>
                )}
              </Box>
            )
          })}
          {v.cache.count > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Button key="block:cache" plain label={`${caret('block:cache')} Cache rebuilt`} onPress={() => toggle($, 'block:cache')}>
                <Text weight="bold" color="claude">{caret('block:cache')} Cache rebuilt</Text>
              </Button>
              <Text dimColor>  {v.cache.count} time{v.cache.count === 1 ? '' : 's'} · {human(v.cache.tokens)} tokens written again</Text>
              {isOpen('block:cache') && v.cache.largest.map((r) => (
                <Text dimColor>    turn {r.seq} · {r.sessionId.slice(0, 8)}{r.gapMinutes !== undefined ? ` · ${Math.round(r.gapMinutes)} min after the previous request` : ''} · {r.tokens.toLocaleString('en-US')} written</Text>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="report" label="Open full report" onPress={async () => { await $.process.run(cli($, ['report', '--html', '--open']), { env: ENV, timeoutMs: 120_000 }) }} />
          </Box>
        </Box>
      )
    }

    const fixesTab = () => {
      const f = fixesView(data)
      const chosen = f.waiting.filter((x) => picks.includes(x.fixId))
      return (
        <Box flexDirection="column" gap={1}>
          {f.waiting.length > 0 && <Text weight="bold">Waiting</Text>}
          {f.waiting.length === 0 &&<Text dimColor>Every fix on offer is applied in this project.</Text>}
          {f.waiting.map((x) => {
            const isPicked = picks.includes(x.fixId)
            return (
              <Box key={`waiting:${x.fixId}`} flexDirection="row" paddingLeft={2}>
                <Button key={`pick:${x.fixId}`} plain label={`${isPicked ? '[x]' : '[ ]'} ${x.text}`} onPress={() => update($, picked, (p) => (isPicked ? p.filter((k) => k !== x.fixId) : [...p, x.fixId]))}>
                  <Text {...(isPicked ? { color: 'claude' } : {})}>{isPicked ? '[x]' : '[ ]'} </Text>
                </Button>
                <Box flexDirection="column" flexShrink={1}>
                  <Text dimColor>For {words(x.dimension)}. {fixKind(x)}</Text>
                  {prompt(fixWords(x), width - 8)}
                  <Text dimColor>{fixWhere(x)}</Text>
                  {requested(x)}
                  {x.applied === undefined && draftedIds.includes(x.fixId) && <Text color="success">✓ Drafted in your prompt box. Press Enter to apply it.</Text>}
                  {x.applied === undefined && draftedIds.includes(x.fixId) && x.target === 'project-instructions' && <Text dimColor>{LOADS}</Text>}
                  {outcomeLine(x)}
                </Box>
              </Box>
            )
          })}
          {f.waiting.length > 0 && (chosen.length === 0
            ? <Text dimColor>  Select fixes, then apply them as one request.</Text>
            : <Box paddingLeft={2}><Button key="apply-picked" variant="primary" label={chosen.length === 1 ? 'Apply' : `Apply ${chosen.length}`} onPress={() => apply($, chosen)} /></Box>)}

          <Text weight="bold">Applied</Text>
          {f.applied.length === 0 && <Text dimColor>None yet. A fix counts as applied once its request is seen in a session.</Text>}
          {f.applied.map((x) => (
            <Box key={`applied:${x.fixId}`} flexDirection="column" paddingLeft={2} marginTop={1}>
              {prompt(fixWords(x), width - 8)}
              <Text color="success">Applied {day(x.applied?.at ?? '')}{x.target === 'project-hooks' ? ' · hook' : ''}</Text>
              {x.before !== undefined && <Text><Text dimColor>Before   </Text>{windowText(x.before)}</Text>}
              {x.since !== undefined && <Text><Text dimColor>Since    </Text>{windowText(x.since)}</Text>}
              {x.cameBack !== undefined && <Text>Came back in {x.cameBack.sessionId.slice(0, 8)}{x.cameBack.turn !== undefined ? `, turn ${x.cameBack.turn}` : ''}</Text>}
            </Box>
          ))}
        </Box>
      )
    }

    // The plan's usage windows exist only on a subscription; that is how the pane tells.
    const subscribed = active === 'health' && await $.session.usage().then((u) => u.rateLimits.length > 0).catch(() => false)
    const healthTab = () => {
      const job = (name: string) => data.health.find((h) => h.job === name)
      const state = (name: string): string => { const h = job(name); return h === undefined ? 'not run yet' : `${h.state}${h.reason !== undefined ? ` · ${h.reason}` : ''}` }
      const line = (label: string, ...values: string[]) => (
        <Box flexDirection="row">
          <Box width={14} flexShrink={0}><Text dimColor>{label}</Text></Box>
          <Box flexDirection="column" flexShrink={1}>{values.map((v) => <Text>{v}</Text>)}</Box>
        </Box>
      )
      const sp = data.spend
      const today = sp?.today
      return (
        <Box flexDirection="column" gap={1}>
          {line('History pass', state('standing'))}
          {line('Judge', state('judge'), `${data.read} of ${data.total} sessions read`)}
          {today !== undefined && line('Today', `${human(today.tokens)} of ${human(today.limit)} tokens${today.tokens >= today.limit ? ' · budget reached, continues tomorrow' : ''}`)}
          {sp?.allTime !== undefined && sp.allTime.calls > 0 && line('Spent', spendText(sp.allTime), ...(sp.allTime.usdMicros !== undefined ? [costNote(subscribed ? 'subscription' : sp.billing)] : []))}
          {sp !== undefined && sp.older > 0 && line('Older', `${sp.older} past session${sp.older === 1 ? '' : 's'} not read`, 'agentsensei judge --backlog reads them')}
          {sp !== undefined && line('Model reads', sp.enabled ? 'on · /agentsensei:judge off stops them' : 'off · /agentsensei:judge on')}
          {line('Dismissed', `${data.dismissed ?? 0} finding${data.dismissed === 1 ? '' : 's'}`)}
        </Box>
      )
    }

    // The mark: cells on a terminal, the SVG where a surface draws one; nothing where neither exists.
    // The mark as a picture where the terminal draws one, the SVG on the desktop, else the wordmark alone.
    const canDraw = (await read($, pictures)) as boolean
    const mark = () => {
      if (e.surface === 'terminal' && canDraw && 'Image' in els) { const { Image } = els; return <Image source={{ png: MARK_PNG }} columns={10} rows={5} alt=" " /> }
      if (e.surface !== 'terminal' && 'Svg' in els) { const { Svg } = els; return <Svg source={MARK_SVG} alt="agentsensei" width={40} height={40} /> }
      return null
    }

    const strip = tabStrip(active, width)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} alignItems="center">
          {mark()}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Text weight="bold" color="claude">agentsensei</Text>
              <Text dimColor>{data.read}/{data.total} sessions read</Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Box flexShrink={1}><Text dimColor>Find out why your agents failed you.</Text></Box>
              {/* Refresh sits on the time it updates, the way a feed's timestamp does. */}
              <Box flexDirection="row" flexShrink={0} gap={1}>
                <Text dimColor>{refreshing ? 'refreshing…' : `updated ${mins === 0 ? 'just now' : `${mins}m ago`}`}</Text>
                <Button key="refresh-top" plain label="↻ Refresh" onPress={() => refresh($)}><Text color="suggestion">↻</Text></Button>
              </Box>
            </Box>
          </Box>
        </Box>
        {failing.length > 0 && (
          <Box flexDirection="column">
            {failing.map((h) => <Text>{h.job === 'judge' ? 'The judge' : 'The history pass'} is {h.state}: {h.reason ?? 'reason unknown'}</Text>)}
          </Box>
        )}

        <Box flexDirection="column">
          <Text color="claude">{strip.top}</Text>
          <Box flexDirection="row">
            {strip.cells.map((c) => (
              <Button key={`tab:${c.key}`} plain label={c.text.trim()} onPress={() => update($, tab, () => c.key)}>
                <Text {...(c.active ? { color: 'claude', weight: 'bold' as const } : { dimColor: true })}>{c.text}</Text>
              </Button>
            ))}
          </Box>
          <Text color="claude">{strip.bottom}</Text>
        </Box>

        {message !== '' && <Text color="suggestion">{message}</Text>}

        {active === 'fixes' ? fixesTab() : active === 'health' ? healthTab() : findingsTab()}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(width)}</Text>
          <Text dimColor>⇥ move · ⏎ press</Text>
        </Box>
      </Box>
    )
  })
}
