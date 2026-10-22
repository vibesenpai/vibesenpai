import { describe, expect, it } from 'vitest';
import {
  commandFileBody,
  fixCommandBody,
  generateReportCommandBody,
  planFor,
} from '../src/install.ts';

describe('an installed copy must not be wired through type stripping', () => {
  // Found by installing the tarball and running the command `planFor` writes:
  //
  //   Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
  //   currently unsupported for files under node_modules
  //
  // A global install lives under `node_modules`, so a `.ts` hook path there
  // can only fail — and `|| true` means it fails silently, which is worse than
  // failing loudly. The CLI now tells `planFor` which form it is running as.
  it('wires compiled paths with no flag when compiled', () => {
    const plan = planFor('/opt/pkg', '/usr/bin/node', true);
    for (const cmd of [plan.hookCommand, plan.sessionStartCommand]) {
      expect(cmd).not.toContain('--experimental-strip-types');
      expect(cmd).toContain('/opt/pkg/dist/scripts/');
      expect(cmd).toMatch(/\.js \|\| true$/);
    }
  });

  it('still wires the source with the flag in a dev checkout', () => {
    // A clone with no `dist/` has nothing else to run, so this path stays.
    const plan = planFor('/home/dev/agentsensei', '/usr/bin/node', false);
    expect(plan.hookCommand).toContain('--experimental-strip-types');
    expect(plan.hookCommand).toContain('/scripts/hook-stop.ts');
  });

  it('writes slash commands that point at the compiled CLI when compiled', () => {
    for (const body of [
      commandFileBody('/opt/pkg', '/usr/bin/node', true),
      fixCommandBody('/opt/pkg', '/usr/bin/node', true),
      generateReportCommandBody('/opt/pkg', '/usr/bin/node', true),
    ]) {
      expect(body).not.toContain('--experimental-strip-types');
      expect(body).toContain('/opt/pkg/dist/src/cli.js');
    }
  });
});
