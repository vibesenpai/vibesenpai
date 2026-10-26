/** Writing our own state files. */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write via a temp file and a rename, so a crash never leaves a half-written file.
 * The temp name carries the pid, so two concurrent writers never share one.
 */
export function writeAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

/** `writeAtomic` for a JSON value, pretty-printed with a trailing newline. */
export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
