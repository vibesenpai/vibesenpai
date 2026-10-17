import { describe, expect, it } from 'vitest';
import { SCHEMA, checkVersion, stamp } from '../src/schema.ts';
import { SKELETON_VERSION } from '../src/types.ts';

describe('schema versioning', () => {
  it('stamps a self-describing envelope', () => {
    expect(stamp('skeleton')).toEqual({
      tool: 'agentsensei',
      schema: 'skeleton',
      v: SCHEMA.skeleton,
    });
  });

  it('accepts the current version', () => {
    expect(checkVersion('finding', SCHEMA.finding)).toEqual({ ok: true });
  });

  it('rejects an OLDER version so a migration is forced, not assumed', () => {
    const r = checkVersion('finding', SCHEMA.finding - 1);
    expect(r).toMatchObject({ ok: false, reason: 'older', expected: SCHEMA.finding });
  });

  it('rejects a NEWER version — silently ignoring future fields is how a tool lies', () => {
    const r = checkVersion('finding', SCHEMA.finding + 1);
    expect(r).toMatchObject({ ok: false, reason: 'newer', expected: SCHEMA.finding });
  });

  it('rejects an unversioned record rather than assuming v1', () => {
    expect(checkVersion('event', undefined)).toEqual({ ok: false, reason: 'unversioned' });
    expect(checkVersion('event', '1')).toEqual({ ok: false, reason: 'unversioned' });
  });

  it('keeps SKELETON_VERSION sourced from SCHEMA, not duplicated', () => {
    expect(SKELETON_VERSION).toBe(SCHEMA.skeleton);
  });
});
