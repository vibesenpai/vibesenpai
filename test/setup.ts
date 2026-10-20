/**
 * Colour off for every test, before any module is imported.
 *
 * `src/style.ts` reads the environment once at import time, so a developer with
 * `AGENTSENSEI_COLOR=1` in their shell would otherwise see two render tests
 * fail on escape sequences interleaved into the strings they assert — a real
 * failure, of the test rather than the code, and one that looks alarming at
 * exactly the wrong moment.
 *
 * Report assertions compare exact columns, so they need one deterministic mode.
 * The colour path is covered directly by `test/style.test.ts`, which builds its
 * own escapes and does not care which mode is active.
 */

delete process.env['AGENTSENSEI_COLOR'];
process.env['NO_COLOR'] = '1';
