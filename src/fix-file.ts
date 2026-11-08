/** Each judged finding's own fix, computed by the standing pass so the pane need not parse sessions. D70. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './files.ts';
import { redact } from './redact.ts';
import type { FindingFixes, FindingFix, SharedFix } from './finding-fix.ts';

const FILE = 'finding-fixes.json';
const VERSION = 1;

export type StoredFixes = {
  v: number;
  computedAt: string;
  /** By finding id. */
  byFinding: Record<string, FindingFix>;
  shared: SharedFix[];
};

/** Every string redacted, so what is persisted is redacted at construction. */
function redacted<T>(value: T): T {
  if (typeof value === 'string') return redact(value).text as T;
  if (Array.isArray(value)) return value.map(redacted) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v)])) as T;
  }
  return value;
}

export function writeFindingFixes(archive: string, fixes: FindingFixes): void {
  const stored: StoredFixes = redacted({
    v: VERSION,
    computedAt: new Date().toISOString(),
    byFinding: Object.fromEntries(fixes.byFinding),
    shared: fixes.shared,
  });
  writeJson(join(archive, FILE), stored);
}

/** Undefined when the file is missing, unreadable or from another version: the pane then offers dimension fixes only. */
export function readFindingFixes(archive: string): StoredFixes | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(archive, FILE), 'utf8')) as Partial<StoredFixes>;
    if (raw.v !== VERSION || raw.byFinding === undefined || !Array.isArray(raw.shared)) return undefined;
    return raw as StoredFixes;
  } catch {
    return undefined;
  }
}
