// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The site lives under /agentsensei on GitHub Pages. `base` has to match or
// every internal link 404s on the deployed copy while working locally — which
// is the classic way a docs deploy looks fine in dev and is broken in public.
export default defineConfig({
  site: 'https://crozzfire.github.io',
  base: '/agentsensei',
  integrations: [
    starlight({
      title: 'agentsensei',
      description:
        "See what your coding agent's mistakes cost you — in tokens, with the exact turns, using the AI you already pay for.",
      social: {
        github: 'https://github.com/crozzfire/agentsensei',
      },
      editLink: {
        baseUrl: 'https://github.com/crozzfire/agentsensei/edit/main/site/',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What it does', slug: 'start/what-it-is' },
            { label: 'Install', slug: 'start/install' },
            { label: 'Your first finding', slug: 'start/first-finding' },
            { label: 'What it sends, and what it costs', slug: 'start/sends-and-costs' },
          ],
        },
        {
          label: 'Findings & fixes',
          items: [
            { label: 'The dimensions', slug: 'findings/dimensions' },
            { label: 'What a fix looks like', slug: 'findings/fixes' },
            { label: 'What we do not detect', slug: 'findings/not-detected' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture/overview' },
            { label: 'Phases of a run', slug: 'architecture/phases' },
            { label: 'Reading a transcript', slug: 'architecture/reading' },
            { label: 'The two tiers', slug: 'architecture/two-tiers' },
            { label: 'The judge pipeline', slug: 'architecture/judge' },
            { label: 'Design decisions', slug: 'architecture/decisions' },
          ],
        },
        {
          label: 'Showing our work',
          items: [
            { label: 'Measuring ourselves', slug: 'work/measuring' },
            { label: 'Limits', slug: 'work/limits' },
            { label: 'What else is out there', slug: 'work/prior-art' },
            { label: 'The graveyard', slug: 'work/graveyard' },
          ],
        },
        { label: 'Reference', slug: 'reference' },
        { label: 'Contribute', slug: 'contribute' },
      ],
    }),
  ],
});
