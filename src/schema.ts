/**
 * Schema versions for everything we persist.
 *
 * The rule: **anything written to disk carries the version of the shape it was
 * written with.** Not because the first shape is likely right, but because it is
 * likely wrong — and a stored record whose shape silently changed is worse than
 * one that fails loudly.
 *
 * Bump a version when the shape changes OR when its meaning changes. A renamed
 * field is a bump; a new optional field is not.
 */

export const SCHEMA = {
  /** `Event` — the normalised turn. Bump invalidates derived caches. */
  event: 1,
  /** `Skeleton` — also the verdict cache key and the future team wire format. */
  skeleton: 1,
  /** `Finding` — persisted in SQLite, read back by the running score. */
  finding: 1,
  /** The catalog's `index.json`. Bump forces a full re-read of all sources. */
  catalog: 1,
  /** SQLite migrations. Bump on every forward migration. */
  store: 1,
} as const;

export type SchemaName = keyof typeof SCHEMA;
export type SchemaVersion<K extends SchemaName> = (typeof SCHEMA)[K];

/**
 * Stamped onto every persisted envelope. `agentsensei` is included so a file
 * found on its own is self-describing.
 */
export type Versioned<K extends SchemaName> = {
  readonly tool: 'agentsensei';
  readonly schema: K;
  readonly v: SchemaVersion<K>;
};

export function stamp<K extends SchemaName>(schema: K): Versioned<K> {
  return { tool: 'agentsensei', schema, v: SCHEMA[schema] };
}

export type VersionCheck =
  | { ok: true }
  | { ok: false; reason: 'newer'; found: number; expected: number }
  | { ok: false; reason: 'older'; found: number; expected: number }
  | { ok: false; reason: 'unversioned' };

/**
 * Checked on read, never assumed.
 *
 * `newer` matters as much as `older`: a file written by a future version may use
 * fields this build will silently ignore, which is exactly how a tool reports
 * confidently wrong numbers. Callers decide what to do — the archive rebuilds,
 * the verdict cache misses, the store migrates — but nobody gets to guess.
 */
export function checkVersion<K extends SchemaName>(schema: K, found: unknown): VersionCheck {
  const expected: number = SCHEMA[schema];
  if (typeof found !== 'number') return { ok: false, reason: 'unversioned' };
  if (found === expected) return { ok: true };
  return { ok: false, reason: found > expected ? 'newer' : 'older', found, expected };
}
