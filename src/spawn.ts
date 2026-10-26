/** Running our own `scripts/*.ts` as child processes. The one place that knows how. */

import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dirname, '..', 'scripts');

function argsFor(script: string, args: string[]): string[] {
  return ['--experimental-strip-types', join(SCRIPTS, script), ...args];
}

/** Start a script and return at once. Its output is discarded; it must never print into a session. */
export function runDetached(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): void {
  try {
    spawn(process.execPath, argsFor(script, args), { detached: true, stdio: 'ignore', env }).unref();
  } catch {
    // Principle Zero: a pass that cannot start must not break the caller.
  }
}

/** Run a script to completion. Throws if it fails. */
export function runAndWait(
  script: string,
  args: string[] = [],
  opts: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): void {
  execFileSync(process.execPath, argsFor(script, args), {
    stdio: opts.inherit === true ? 'inherit' : 'ignore',
    env: opts.env ?? process.env,
  });
}
