// What the insights pane shows, worked out from `report --json`. Pure: no `$`, so it is tested alone.

import type { PaneData, PaneFix, PaneRebuild, PaneRow } from '../types'

/** One finding as the pane lists it. The method is always carried: a model's reading never passes for a rule's. */
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
}

export type Block = { dimension: string; items: Item[]; sessions: number; fix?: PaneFix }

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
        why: j.why,
        ...(j.asked !== undefined ? { asked: j.asked.text } : {}),
        ...(j.established !== undefined ? { established: j.established } : {}),
        occurrences: 1,
        written: 0,
        reasons: [],
        rows: [],
        ...(j.id !== undefined ? { dismissId: j.id } : {}),
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
      })
    }
  }
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/** New since `since`, then one block per dimension (most findings first), then the cache. */
export function view(data: PaneData, since: string | undefined, filter: string): View {
  const all = itemsOf(data).filter((i) => filter === 'all' || i.method === filter)
  const newItems = since === undefined ? [] : all.filter((i) => i.at !== undefined && i.at > since).slice(0, NEW_SHOWN)

  const byDim = new Map<string, Item[]>()
  for (const i of all) byDim.set(i.dimension, [...(byDim.get(i.dimension) ?? []), i])
  const blocks: Block[] = [...byDim]
    .map(([dimension, items]) => {
      const fix = data.recommendations[dimension]
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
