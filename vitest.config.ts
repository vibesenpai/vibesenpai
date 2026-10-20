import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Runs before any module import, so `src/style.ts` sees colour disabled
    // whatever the developer's shell has set. See `test/setup.ts`.
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
