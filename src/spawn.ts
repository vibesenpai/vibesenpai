/** Running our own `scripts/*.ts` as child processes. The one place that knows how. */

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCRIPTS = join(import.meta.dirname, '..', 'scripts');

function argsFor(script: string, args: string[]): string[] {
  return ['--experimental-strip-types', join(SCRIPTS, script), ...args];
}

/**
 * Start a script and return its pid at once. It must never print into a session: stdout is discarded,
 * and stderr goes to `stderrFile` if given (the worker unlinks it as its first act; see `runJob`).
 */
export function runDetached(
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  stderrFile?: string,
): number | undefined {
  let fd: number | undefined;
  try {
    if (stderrFile !== undefined) {
      mkdirSync(dirname(stderrFile), { recursive: true, mode: 0o700 });
      fd = openSync(stderrFile, 'w', 0o600);
    }
    const child = spawn(process.execPath, argsFor(script, args), {
      detached: true,
      stdio: ['ignore', 'ignore', fd ?? 'ignore'],
      env,
    });
    child.unref();
    return child.pid;
  } catch {
    // Principle Zero: a pass that cannot start must not break the caller.
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
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
