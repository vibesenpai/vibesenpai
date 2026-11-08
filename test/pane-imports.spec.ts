import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// A pane module may import its own files by relative path and "claude-code", nothing else.
const ALLOWED_BARE = new Set(['claude-code']);
const IMPORT = /^(?:import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms;

function resolveLocal(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p) && !p.endsWith('/'));
}

/** Every value import reachable from `entry`, as [importer, specifier]. */
function valueImports(entry: string): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (m[1] !== undefined) continue;
      const spec = m[2] as string;
      out.push([file, spec]);
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next !== undefined) walk(next);
      }
    }
  };
  walk(resolve(entry));
  return out;
}

describe('the pane module loads', () => {
  it('reaches nothing but its own files and claude-code', () => {
    const bad = valueImports('hooks/pane.tsx')
      .filter(([, spec]) => !spec.startsWith('.') && !ALLOWED_BARE.has(spec))
      .map(([file, spec]) => `${file.replace(`${process.cwd()}/`, '')} imports ${spec}`);
    expect(bad).toEqual([]);
  });
});
