/** Every docs page the pane links to exists on the site. Read as text: `hooks/` is outside the root tsconfig. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const exists = (slug: string): boolean => {
  const base = `site/src/content/docs/${slug === '' ? 'index' : slug}`;
  return [`${base}.md`, `${base}.mdx`, `${base}/index.md`].some((p) => existsSync(p));
};

describe('the pane links to pages that exist', () => {
  it('every docs(...) slug in the pane', () => {
    const src = readFileSync('hooks/pane.tsx', 'utf8');
    const slugs = [...src.matchAll(/\bdocs\('([^']*)'\)/g)].map((m) => m[1] as string);
    expect(slugs.length).toBeGreaterThan(0);
    for (const s of ['', ...slugs]) expect(exists(s), s).toBe(true);
  });

  it('every dimension page, and the overview a page-less one falls back to', () => {
    const shape = readFileSync('hooks/shape.ts', 'utf8');
    const set = /DIMENSION_PAGES = new Set\(\[([^\]]*)\]\)/.exec(shape)?.[1] ?? '';
    const dims = [...set.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(dims.length).toBeGreaterThan(0);
    for (const d of dims) expect(exists(`dimensions/${d.replace(/_/g, '-')}`), d).toBe(true);
    expect(exists('dimensions')).toBe(true);
  });
});
