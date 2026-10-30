/** `excerpt`: the conversation around a finding's turns, as JSON for the pane. Reads in place; writes nothing. */

import { parse } from '../parsers/index.ts';
import { withFullText } from '../parsers/claude-code.ts';
import { findSessionSource, readSession } from '../read.ts';
import { excerptOf, type Excerpt } from '../excerpt.ts';
import { type Argv, configFromFlags } from './common.ts';

/**
 * ```
 *   excerpt <session> --turns 5208,5210 [--around 3]
 * ```
 * `{ kept: false }` once the harness has deleted the transcript.
 */
export function cmdExcerpt(a: Argv): number {
  const { config } = configFromFlags(a);
  const id = a._[1];
  const turns = String(a.flags['turns'] ?? '').split(',').map(Number).filter(Number.isFinite);
  const around = Math.max(1, Number(a.flags['around'] ?? 3) || 3);
  if (id === undefined || turns.length === 0) {
    console.error('usage: excerpt <session> --turns <a,b> [--around n]');
    return 1;
  }
  const source = findSessionSource(config.sources, id);
  let out: Excerpt = { kept: false };
  if (source !== undefined) {
    try {
      const read = readSession({ source, sessionId: id, mode: 'live' });
      const { result, fullText } = withFullText(() => parse(source, read.text, id));
      const events = [...result.events].sort((x, y) => x.seq - y.seq);
      out = excerptOf(events, fullText, turns, around);
    } catch {
      out = { kept: false };
    }
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}
