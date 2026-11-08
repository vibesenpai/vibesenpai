/**
 * The `Stop` hook: heals and starts the background jobs, the judge included. The only automatic spender,
 * and so the only caller held to the spend limits.
 * It prints nothing (Principle One: the report belongs at session start) and exits 0.
 */

import { resolveConfig } from '../src/config.ts';
import { superviseAll } from '../src/jobs.ts';

try {
  if (process.env['VIBESENPAI_DISABLE'] !== '1') superviseAll(resolveConfig().config, { judge: true, limits: true });
} catch {
  // Silent: a hook must exit 0 and must not surface outside session start.
}
process.exit(0);
