/**
 * Colour off for every test, before any module is imported: `src/style.ts` reads the env at
 * import time, and render tests assert exact columns. Colour is covered by `test/style.spec.ts`.
 */

delete process.env['AGENTSENSEI_COLOR'];
process.env['NO_COLOR'] = '1';
