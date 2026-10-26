/**
 * Schema versions for everything we persist; every record on disk carries one.
 * Bump when shape or meaning changes: a renamed field is a bump, a new optional field is not.
 */

export const SCHEMA = {
  /** `Event` — the normalised turn. Bump invalidates derived caches. */
  event: 1,
  /** `Skeleton` — also the verdict cache key and the future team wire format. */
  skeleton: 1,
  /** `Finding` — persisted as atomic occurrences; see `src/store.ts`. */
  finding: 1,
  /** The catalog's `index.json`. Bump forces a full re-read of all sources. */
  catalog: 1,
  /** The SQLite store (`meta.schema_version`). Bump on every forward migration. */
  store: 1,
} as const;

type SchemaName = keyof typeof SCHEMA;
type SchemaVersion<K extends SchemaName> = (typeof SCHEMA)[K];

/** Stamped onto every persisted envelope, so a file found on its own is self-describing. */
export type Versioned<K extends SchemaName> = {
  readonly tool: 'agentsensei';
  readonly schema: K;
  readonly v: SchemaVersion<K>;
};

export function stamp<K extends SchemaName>(schema: K): Versioned<K> {
  return { tool: 'agentsensei', schema, v: SCHEMA[schema] };
}

type VersionCheck =
  | { ok: true }
  | { ok: false; reason: 'newer'; found: number; expected: number }
  | { ok: false; reason: 'older'; found: number; expected: number }
  | { ok: false; reason: 'unversioned' };

/**
 * Checked on read, never assumed. `newer` matters too: a future file may carry fields this build ignores.
 */
export function checkVersion<K extends SchemaName>(schema: K, found: unknown): VersionCheck {
  const expected: number = SCHEMA[schema];
  if (typeof found !== 'number') return { ok: false, reason: 'unversioned' };
  if (found === expected) return { ok: true };
  return { ok: false, reason: found > expected ? 'newer' : 'older', found, expected };
}
