#!/usr/bin/env node
// The npx entry point; the logic is in lib/cli.mjs. DECISIONS.md D74.
import { defaultDeps, main } from '../lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2), defaultDeps());
