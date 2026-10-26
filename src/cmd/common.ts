/** What every command shares: parsed argv, resolved config, the chosen detectors. */

import { dim } from '../style.ts';
import { resolveConfig } from '../config.ts';
import { readCatalog } from '../catalog.ts';
import { parse } from '../parsers/index.ts';
import { findSessionSource, readSession, sessionSizes } from '../read.ts';
import { readJudgeState } from '../judge/state.ts';
import { pendingWork } from '../judge/schedule.ts';
import { buildSkeletons, renderSkeleton } from '../skeleton.ts';
import { detectorsFor, unknownDimensions } from '../detect/index.ts';
import type { Detector } from '../detect/index.ts';
import type { Preset } from '../types.ts';
import { duration } from '../format.ts';

export type Argv = { _: string[]; flags: Record<string, string | boolean | string[]> };

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function configFromFlags(a: Argv) {
  const f = a.flags;
  const sources = f['source'];
  return resolveConfig({
    flags: {
      ...(Array.isArray(sources) ? { sources } : {}),
      ...(typeof f['archive'] === 'string' ? { archive: f['archive'] } : {}),
      ...(typeof f['config'] === 'string' ? { config: f['config'] } : {}),
      ...(typeof f['preset'] === 'string' ? { preset: f['preset'] } : {}),
      ...(Array.isArray(f['mute']) ? { mute: f['mute'] as string[] } : {}),
    },
  });
}

/** The detectors this invocation will run. Bad presets or mute names warn, never stop or pass silently. */
export function detectorsFromConfig(cfg: { preset: Preset; mute: string[] }): Detector[] {
  for (const w of unknownDimensions(cfg.mute)) {
    console.error(`warning: --mute ${w} names no dimension — nothing was silenced by it`);
  }
  return detectorsFor(cfg.preset, undefined, cfg.mute);
}

/** Resolve a session to a source path plus its catalog offset, if any. `--live` reads past the catalog. */
export function openSession(
  a: Argv,
  sessionId: string,
  config: { sources: string[]; archive: string },
): { source: string; offset: number | undefined } {
  const live = a.flags['live'] === true;
  const index = readCatalog(config.archive);
  const entry = index
    ? Object.values(index.entries).find((e) => e.sessionId === sessionId)
    : undefined;

  const source = entry?.source ?? findSessionSource(config.sources, sessionId);
  if (source === undefined) {
    throw new Error(
      `no transcript found for session ${sessionId}\n` +
        `searched: ${config.sources.join(', ')}`,
    );
  }
  if (entry?.gone !== undefined) {
    throw new Error(
      `the transcript for ${sessionId} was deleted by the harness on ` +
        `${entry.gone.slice(0, 10)} — evidence for it is no longer readable`,
    );
  }
  return { source, offset: live ? undefined : entry?.offset };
}

export function printSkeletons(
  a: Argv,
  sessionId: string,
  source: string,
  offset: number | undefined,
  // `now` is live by definition; `skeleton` must not silently become live.
  allowLiveFallback = false,
): number {
  const explicitLive = a.flags['live'] === true;
  if (!explicitLive && offset === undefined && !allowLiveFallback) {
    throw new Error(
      `${sessionId} is not in the catalog yet — run \`agentsensei scan\`, ` +
        `or pass --live to read the source as it is on disk now`,
    );
  }
  const mode = explicitLive || offset === undefined ? 'live' : 'catalogued';
  const read = readSession({ source, sessionId, mode, ...(offset !== undefined ? { catalogOffset: offset } : {}) });

  const parsed = parse(source, read.text, sessionId);
  const skeletons = buildSkeletons(sessionId, parsed.events);

  console.log(
    `${sessionId} · ${mode} · ${fmtBytes(read.bytesRead)}` +
      (read.ahead > 0 ? ` (${fmtBytes(read.ahead)} past the last scan)` : '') +
      (read.partialTail ? ' · a partial trailing line was left unread' : ''),
  );
  console.log(
    `${parsed.events.length} events · ${skeletons.length} window${skeletons.length === 1 ? '' : 's'}` +
      (parsed.malformed > 0 ? ` · ${parsed.malformed} malformed line(s)` : '') +
      (parsed.abandoned > 0 ? ` · ${parsed.abandoned} on abandoned branches` : '') +
      ` · parser ${parsed.provenance.version ?? '(no version)'} ${parsed.provenance.match}`,
  );

  if (skeletons.length === 0) {
    console.log('\nno windows — the session produced no analysable turns');
    return 0;
  }

  const pick = a.flags['window'];
  const only = typeof pick === 'string' ? Number(pick) : undefined;
  if (only !== undefined && (!Number.isInteger(only) || only < 1 || only > skeletons.length)) {
    throw new Error(`--window expects 1..${skeletons.length} (got "${String(pick)}")`);
  }

  const shown = only === undefined ? skeletons : [skeletons[only - 1] as (typeof skeletons)[number]];
  for (const [i, sk] of shown.entries()) {
    const n = only ?? i + 1;
    const tag = sk.sidechainId !== undefined ? `  [subagent ${sk.sidechainId.slice(0, 8)}]` : '';
    console.log(`\n── window ${n}/${skeletons.length}${tag}`);
    console.log(renderSkeleton(sk));
  }
  return 0;
}

/** One line, only while a judge pass still has work, so "found nothing" differs from "not done yet". */
export function judgePendingLine(config: { archive: string; sources: string[] }): string | undefined {
  const state = readJudgeState(config.archive);
  if (!state.settings.enabled) return undefined;
  const { pending, seconds } = pendingWork(state, sessionSizes(config.sources));
  if (pending === 0) return undefined;
  return dim(
    `⌁ the judge still has ${pending} session(s) to read — about ${duration(seconds)}. ` +
      `Findings will appear here once it has.`,
  );
}
