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
        "See what your coding agent's mistakes cost you — in tokens, with the exact turns, on your own machine.",
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
            { label: 'What it is', slug: 'start/what-it-is' },
            { label: 'Install', slug: 'start/install' },
            { label: 'Your first finding', slug: 'start/first-finding' },
            { label: 'Turning the judge on', slug: 'start/the-judge' },
          ],
        },
        {
          label: 'What it finds',
          items: [
            { label: 'The dimensions', slug: 'finds/dimensions' },
            { label: 'What we do not detect', slug: 'finds/not-detected' },
          ],
        },
        {
          label: 'Fixes',
          items: [
            { label: 'Config, a tool, or nothing', slug: 'fixes/kinds' },
          ],
        },
        {
          label: 'Trust',
          items: [
            { label: 'What leaves your machine', slug: 'trust/egress' },
            { label: 'Limits', slug: 'trust/limits' },
          ],
        },
        {
          label: 'Showing our work',
          items: [
            { label: 'Measuring ourselves', slug: 'work/measuring' },
            { label: 'The graveyard', slug: 'work/graveyard' },
          ],
        },
        { label: 'Contribute', slug: 'contribute' },
      ],
    }),
  ],
});
