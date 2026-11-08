// What the insights pane shows, worked out from `report --json`. Pure: no `$`, so it is tested alone.

import type { PaneData, PaneFixState, PaneRebuild, PaneRow, PaneSpend, PaneSpendWindow, PaneWindow } from '../types'

/** One finding as the pane lists it. The method is carried in the data and never shown. */
export type Item = {
  key: string
  dimension: string
  /** Other kinds a model finding also is. */
  secondaryDimensions?: string[]
  method: 'model' | 'rule'
  /** When it was judged (model) or the session's last turn (rule); undefined when unknown. */
  at?: string
  sessionId: string
  project: string
  turns: number[]
  quote?: string
  quoteBy?: 'developer' | 'agent'
  why?: string
  asked?: string
  /** Where the expectation was set (model findings with lookback). */
  established?: string
  subject?: string
  occurrences: number
  written: number
  reasons: string[]
  rows: PaneRow[]
  /** What `agentsensei dismiss` takes. */
  dismissId?: string
  /** When the first cited turn was written. */
  turnAt?: string
}

export type Block = { dimension: string; items: Item[]; sessions: number; fix?: PaneFixState }

export type CacheSummary = { count: number; tokens: number; largest: (PaneRebuild & { sessionId: string })[] }

export type View = { newItems: Item[]; blocks: Block[]; cache: CacheSummary }

export const NEW_SHOWN = 3
export const BLOCK_SHOWN = 2

export function itemsOf(data: PaneData): Item[] {
  const out: Item[] = []
  for (const s of data.sessions) {
    for (const j of s.judged) {
      out.push({
        key: j.id ?? `${s.sessionId}:${j.turns.join(',')}`,
        dimension: j.dimension,
        ...(j.secondaryDimensions !== undefined && j.secondaryDimensions.length > 0 ? { secondaryDimensions: j.secondaryDimensions } : {}),
        method: 'model',
        at: j.at,
        sessionId: s.sessionId,
        project: s.project,
        turns: j.turns,
        ...(j.quote !== undefined && j.quote !== '' ? { quote: j.quote } : {}),
        ...(j.quoteBy !== undefined ? { quoteBy: j.quoteBy } : {}),
        why: j.why,
        ...(j.asked !== undefined ? { asked: j.asked.text } : {}),
        ...(j.established !== undefined ? { established: j.established } : {}),
        occurrences: 1,
        written: 0,
        reasons: [],
        rows: [],
        ...(j.id !== undefined ? { dismissId: j.id } : {}),
        ...(j.turnAt !== undefined ? { turnAt: j.turnAt } : {}),
      })
    }
    for (const f of s.findings) {
      out.push({
        key: `${f.id}:${s.sessionId}`,
        dimension: f.dimension,
        method: 'rule',
        ...(s.lastTs !== undefined ? { at: s.lastTs } : {}),
        sessionId: s.sessionId,
        project: s.project,
        turns: f.evidence.map((r) => Number(r.turn)).filter(Number.isFinite),
        subject: f.subject,
        occurrences: f.occurrences,
        written: f.cost.written,
        reasons: f.reasons.map((r) => `${r.count}× ${r.reason.replace(/-/g, ' ')}`),
        rows: f.evidence,
        ...(f.evidence.find((r) => r.asked !== undefined)?.asked !== undefined
          ? { asked: (f.evidence.find((r) => r.asked !== undefined)?.asked as { text: string }).text }
          : {}),
        dismissId: f.id,
        ...(f.evidence[0]?.ts !== undefined ? { turnAt: f.evidence[0].ts } : {}),
      })
    }
  }
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/** New since `since`, then one block per dimension (most findings first), then the cache. */
export function view(data: PaneData, since: string | undefined): View {
  const all = itemsOf(data)
  const newItems = since === undefined ? [] : all.filter((i) => i.at !== undefined && i.at > since).slice(0, NEW_SHOWN)

  const byDim = new Map<string, Item[]>()
  for (const i of all) byDim.set(i.dimension, [...(byDim.get(i.dimension) ?? []), i])
  const blocks: Block[] = [...byDim]
    .map(([dimension, items]) => {
      const fix = data.fixes?.find((f) => f.dimension === dimension)
      return {
        dimension,
        items,
        sessions: new Set(items.map((i) => i.sessionId)).size,
        ...(fix !== undefined ? { fix } : {}),
      }
    })
    .sort((a, b) => count(b) - count(a))

  const rebuilds = data.sessions.flatMap((s) => (s.stats.rebuilds?.events ?? []).map((r) => ({ ...r, sessionId: s.sessionId })))
  return {
    newItems,
    blocks,
    cache: {
      count: rebuilds.length,
      tokens: rebuilds.reduce((n, r) => n + r.tokens, 0),
      largest: [...rebuilds].sort((a, b) => b.tokens - a.tokens).slice(0, 3),
    },
  }
}

const count = (b: Block): number => b.items.reduce((n, i) => n + i.occurrences, 0)
export const blockCount = count

/** `misread_intent` → `misread intent`. */
export const words = (dimension: string): string => dimension.replace(/_/g, ' ')

/** Cut to `max` characters on one line, with an ellipsis when cut. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`
}

/** `today`, `yesterday`, or `10-21`. */
export function when(iso: string | undefined, now: Date): string {
  if (iso === undefined) return 'date unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'date unknown'
  const day = (x: Date): string => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  if (day(d) === day(now)) return 'today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (day(d) === day(y)) return 'yesterday'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `1.5k`, `797k`, `17.9M`. */
export function human(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** `$1.87`, or `< $0.01` below a cent. From micro-dollars. */
export function dollars(micros: number): string {
  return micros < 10_000 ? '< $0.01' : `$${(micros / 1e6).toFixed(2)}`
}

/** `Oct 29`, in the local time zone. */
/** `2:14 PM`, local. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** `12 calls · 610k in · 40k out · $0.31`. */
export function spendText(w: PaneSpendWindow): string {
  const usd = w.usdMicros === undefined ? '' : ` · ${dollars(w.usdMicros)}`
  return `${w.calls} call${w.calls === 1 ? '' : 's'} · ${human(w.tokensIn)} in · ${human(w.tokensOut)} out${usd}`
}

export type Billing = 'subscription' | PaneSpend['billing']

/** What the dollar figure means, by how the person is billed. */
export function costNote(billing: Billing): string {
  if (billing === 'subscription') return "At API prices. On a subscription this comes out of your plan's usage, not a bill."
  if (billing === 'api') return "Billed to your API key: Claude Code's own figure."
  return "At API prices; on a subscription it comes out of your plan's usage instead."
}

/** `3 times in 2 sessions`. */
export function timesIn(times: number, sessions: number): string {
  return `${times} time${times === 1 ? '' : 's'} in ${sessions} session${sessions === 1 ? '' : 's'}`
}

export const windowText = (w: PaneWindow): string => timesIn(w.times, w.sessions)

/** Fixes not yet applied in this project, and those that were, most recent first. */
export function fixesView(data: PaneData): { waiting: PaneFixState[]; applied: PaneFixState[] } {
  const all = data.fixes ?? []
  return {
    // Requested but never loaded stays offered: the developer may have declined it.
    waiting: all.filter((f) => f.applied === undefined || f.inEffect === false),
    applied: all.filter((f) => f.applied !== undefined && f.inEffect !== false).sort((a, b) => (b.applied?.at ?? '').localeCompare(a.applied?.at ?? '')),
  }
}

export const TABS = [['findings', 'Findings'], ['fixes', 'Fixes'], ['health', 'Health']] as const

/**
 * The folder tab: the active label boxed and open at the bottom, joined to a rule the pane's width.
 * Returns the line above the labels, each label's padded text, and the line below.
 */
export function tabStrip(active: string, width: number): { top: string; cells: { key: string; text: string; active: boolean }[]; bottom: string } {
  let top = ''
  let bottom = ''
  const cells = TABS.map(([key, label]) => {
    const on = key === active
    const w = label.length + 2
    top += on ? `╭${'─'.repeat(w)}╮` : ' '.repeat(w + 2)
    bottom += on ? `┘${' '.repeat(w)}└` : '─'.repeat(w + 2)
    return { key, text: on ? `│ ${label} │` : `  ${label}  `, active: on }
  })
  return { top, cells, bottom: bottom + '─'.repeat(Math.max(0, width - bottom.length)) }
}

/** What kind of change a fix makes, in words, by its harness-neutral target. */
export function fixKind(f: PaneFixState): string {
  return f.target === 'project-instructions'
    ? 'A rule the agent reads in every session of this project:'
    : f.target === 'project-hooks'
      ? 'A check that runs each time the agent finishes a turn:'
      : 'An instruction for this session only:'
}

/** Where it goes, as a sentence; a session fix goes nowhere on disk. */
export const fixWhere = (f: PaneFixState): string => (f.target === 'session' ? 'Sent as a prompt; nothing is written.' : `Added to ${f.destination}`)

/** The fix's own words, without the list dash a rules file needs. */
export const fixWords = (f: PaneFixState): string => f.text.replace(/^-\s*/, '')

/** Word-wrapped to `max` columns, so each line can carry its own prefix (a bar the layout cannot repeat). */
export function wrapLines(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line !== '' && line.length + 1 + word.length > max) {
      out.push(line)
      line = ''
    }
    // A word longer than a line is cut, not left to overflow.
    let w = word
    while (w.length > max) {
      if (line !== '') { out.push(line); line = '' }
      out.push(w.slice(0, max))
      w = w.slice(max)
    }
    line = line === '' ? w : `${line} ${w}`
  }
  if (line !== '') out.push(line)
  return out
}

/** Braille dots, one frame per tick. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type BarRun = { text: string; tone: 'done' | 'glint' | 'rest' }

/**
 * A progress bar in heavy rules, `━━━━╸━━━`, as runs of one tone each. While `moving`, a short glint
 * sweeps the done part, one cell per frame. The fill comes from real counts only.
 */
export function barRuns(done: number, total: number, cells: number, frame: number, moving: boolean): BarRun[] {
  const exact = total <= 0 ? 0 : Math.min(1, done / total) * cells
  const full = Math.floor(exact)
  const half = exact - full >= 0.5 && full < cells
  const tones: BarRun['tone'][] = Array.from({ length: cells }, (_, i) => (i < full || (i === full && half) ? 'done' : 'rest'))
  if (moving && full > 0) {
    const at = (frame % (full + 6)) - 3
    for (let i = at; i < at + 3; i++) if (i >= 0 && i < full) tones[i] = 'glint'
  }
  const glyph = (i: number): string => (i === full && half ? '╸' : '━')
  const runs: BarRun[] = []
  tones.forEach((tone, i) => {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.tone === tone) last.text += glyph(i)
    else runs.push({ tone, text: glyph(i) })
  })
  return runs
}

/** `about 3 min`, from a measured estimate. */
export function aboutTime(seconds: number): string {
  if (seconds < 90) return 'about a minute'
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} min`
  return `about ${Math.round(seconds / 3600)} h`
}

/** `Tuesday` within the week, else `Nov 9`. */
export function finishDay(iso: string, now: Date): string {
  const d = new Date(iso)
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000)
  if (days <= 1) return 'tomorrow'
  return days < 7 ? d.toLocaleDateString('en-US', { weekday: 'long' }) : shortDay(iso)
}
