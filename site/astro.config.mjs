// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// The site lives under /vibesenpai on GitHub Pages. `base` has to match or
// every internal link 404s on the deployed copy while working locally — which
// is the classic way a docs deploy looks fine in dev and is broken in public.
export default defineConfig({
  site: 'https://vibesenpai.github.io',
  base: '/vibesenpai',
  // Pages that moved in the 2026-11 overhaul.
  redirects: {
    '/findings/dimensions': '/vibesenpai/dimensions/',
    '/findings/fixes': '/vibesenpai/start/fixes/',
  },
  integrations: [
    starlight({
      title: 'vibesenpai',
      customCss: ['./src/styles/brand.css'],
      components: { Hero: './src/components/HomeHero.astro' },
      plugins: [starlightLinksValidator()],
      // The brand lives in `assets/brand/` at the repo root; the site keeps
      // copies because Vite will not serve files from outside its own root.
      logo: { src: './src/assets/mark.svg' },
      favicon: '/favicon.svg',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://vibesenpai.github.io/vibesenpai/og.jpg' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://vibesenpai.github.io/vibesenpai/og.jpg' } },
      ],
      description:
        "Discover how your agents failed you. vibesenpai reads the sessions already on your disk and shows you the exact turns, what you'd asked for, and what it cost.",
      social: {
        github: 'https://github.com/vibesenpai/vibesenpai',
      },
      editLink: {
        baseUrl: 'https://github.com/vibesenpai/vibesenpai/edit/main/site/',
      },
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'What it shows you', slug: 'start/what-it-is' },
            { label: 'Install and update', slug: 'start/install' },
            { label: 'A tour of the pane', slug: 'start/pane' },
            { label: 'Your first finding', slug: 'start/first-finding' },
            { label: 'Fixes and Apply', slug: 'start/fixes' },
          ],
        },
        {
          label: 'Dimensions',
          items: [
            { label: 'Overview', slug: 'dimensions' },
            { label: 'Constraint violation', slug: 'dimensions/constraint-violation' },
            { label: 'Misread intent', slug: 'dimensions/misread-intent' },
            { label: 'Inaccurate self report', slug: 'dimensions/inaccurate-self-report' },
            { label: 'Overreach', slug: 'dimensions/overreach' },
            { label: 'Other', slug: 'dimensions/other' },
            { label: 'Edit retry', slug: 'dimensions/edit-retry' },
            { label: 'Repeated call', slug: 'dimensions/redundant-call' },
            { label: 'Cache rebuilds', slug: 'dimensions/cache-rebuilds' },
          ],
        },
        {
          label: 'Commands',
          items: [
            { label: '/vibesenpai:insights', slug: 'commands/insights' },
            { label: '/vibesenpai:judge', slug: 'commands/judge' },
            { label: '/vibesenpai:report', slug: 'commands/report' },
          ],
        },
        {
          label: 'Trust',
          items: [
            { label: 'What leaves your machine', slug: 'start/sends-and-costs' },
            { label: 'How accurate it is', slug: 'work/measuring' },
            { label: 'Limits', slug: 'work/limits' },
            { label: 'What we do not detect', slug: 'findings/not-detected' },
            { label: 'The graveyard', slug: 'work/graveyard' },
            { label: 'What else is out there', slug: 'work/prior-art' },
          ],
        },
        { label: 'Reference', slug: 'reference' },
        {
          label: 'Under the hood',
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'architecture/overview' },
            { label: 'Phases of a run', slug: 'architecture/phases' },
            { label: 'Reading a transcript', slug: 'architecture/reading' },
            { label: 'The two tiers', slug: 'architecture/two-tiers' },
            { label: 'The judge pipeline', slug: 'architecture/judge' },
            { label: 'Design decisions', slug: 'architecture/decisions' },
            { label: 'Releases and install counts', slug: 'architecture/releases' },
          ],
        },
        { label: 'Contribute', slug: 'contribute' },
      ],
    }),
  ],
});
