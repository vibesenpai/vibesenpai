// `npx vibesenpai install`: shows Claude Code's own install command, asks, then runs it.
// It writes nothing itself and has no postinstall. DECISIONS.md D74.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const MIN_NODE = [22, 13, 0];
const MIN_CLAUDE = [2, 1, 299];
const SCOPES = ['user', 'project', 'local'];
const DOCS = 'https://vibesenpai.github.io/vibesenpai/';

const HELP = `vibesenpai shows the turns where your coding agent went wrong, with a fix you can apply.
It is a Claude Code plugin.

Usage:
  npx vibesenpai install [--scope user|project|local] [--yes]

install   shows Claude Code's own install command, asks, then runs it:
          claude plugin install vibesenpai --marketplace vibesenpai/vibesenpai
--scope   where Claude Code installs it (default: user)
--yes     skip the question; needed when no terminal is attached

Or, in Claude Code:
  /plugin marketplace add vibesenpai/vibesenpai
  /plugin install vibesenpai@vibesenpai

Docs: ${DOCS}`;

/**
 * @typedef {object} Deps
 * @property {(cmd: string, args: string[]) => Promise<number>} run  runs with the output shown live; resolves to the exit code
 * @property {(cmd: string, args: string[]) => Promise<string | null>} capture  stdout, or null when the command could not start
 * @property {(question: string) => Promise<string>} ask
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 * @property {boolean} interactive  stdin and stdout are both a terminal
 * @property {string} nodeVersion
 */

/** @param {string} text @returns {number[] | null} */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {number[]} a @param {number[]} b @returns {boolean} a >= b */
export function atLeast(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * @param {string[]} argv
 * @returns {{ command: string | null, yes: boolean, scope: string | null, help: boolean } | { error: string }}
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let command = null;
  let yes = false;
  let help = false;
  /** @type {string | null} */
  let scope = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--scope' || a === '-s') {
      const v = argv[++i];
      if (v === undefined) return { error: '--scope needs a value: user, project or local' };
      scope = v;
    } else if (a.startsWith('--scope=')) scope = a.slice('--scope='.length);
    else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else if (command === null) command = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (scope !== null && !SCOPES.includes(scope)) {
    return { error: `--scope must be user, project or local, not ${scope}` };
  }
  return { command, yes, scope, help };
}

/** @param {string | null} scope @returns {string[]} */
export function installArgs(scope) {
  const args = ['plugin', 'install', 'vibesenpai', '--marketplace', 'vibesenpai/vibesenpai'];
  return scope ? [...args, '--scope', scope] : args;
}

/** @param {string[]} argv @param {Deps} deps @returns {Promise<number>} */
export async function main(argv, deps) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    deps.err(`vibesenpai: ${parsed.error}\n\n${HELP}`);
    return 2;
  }
  if (parsed.help || parsed.command === null) {
    deps.out(HELP);
    return 0;
  }
  if (parsed.command !== 'install') {
    deps.err(`vibesenpai: unknown command ${parsed.command}\n\n${HELP}`);
    return 2;
  }

  const node = parseVersion(deps.nodeVersion);
  if (node && !atLeast(node, MIN_NODE)) {
    deps.err(`vibesenpai needs Node ${MIN_NODE.slice(0, 2).join('.')} or later on your PATH; this is ${deps.nodeVersion}.`);
    return 1;
  }

  const version = await deps.capture('claude', ['--version']);
  if (version === null) {
    deps.err("Claude Code's `claude` command is not on your PATH. Install Claude Code first: https://code.claude.com/docs");
    return 1;
  }
  const claude = parseVersion(version);
  if (claude && !atLeast(claude, MIN_CLAUDE)) {
    deps.err(`vibesenpai needs Claude Code ${MIN_CLAUDE.join('.')} or later; this is ${claude.join('.')}. \`claude update\` installs the latest.`);
    return 1;
  }

  const args = installArgs(parsed.scope);
  deps.out(`This runs Claude Code's own installer:\n\n  claude ${args.join(' ')}\n`);
  if (!parsed.yes) {
    if (!deps.interactive) {
      deps.out('No terminal to ask in. Run that command yourself, or rerun with --yes.');
      return 1;
    }
    const answer = (await deps.ask('Install? [y/N] ')).trim();
    if (!/^y(es)?$/i.test(answer)) {
      deps.out('Nothing was installed.');
      return 1;
    }
  }

  const code = await deps.run('claude', args);
  if (code !== 0) {
    deps.err(`Claude Code's installer exited with code ${code}.`);
    return code;
  }
  deps.out('\nRestart Claude Code, then run /vibesenpai:insights.\nModel reads stay off until you say yes, after seeing what they would send.');
  return 0;
}

/** @param {NodeJS.Platform} platform @returns {boolean} */
export function needsShell(platform) {
  // Windows installs `claude` as a .cmd shim, which Node only starts through a shell.
  return platform === 'win32';
}

/** @returns {Deps} */
export function defaultDeps() {
  const shell = needsShell(process.platform);
  return {
    run: (cmd, args) =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: 'inherit', shell });
        child.on('error', () => resolve(127));
        child.on('close', (code) => resolve(code ?? 1));
      }),
    capture: (cmd, args) =>
      new Promise((resolve) => {
        // stdin closed, or a child waiting on it never exits.
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], shell });
        let text = '';
        child.stdout.on('data', (d) => { text += String(d); });
        child.on('error', () => resolve(null));
        child.on('close', (code) => resolve(code === 0 ? text : null));
      }),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(question); } finally { rl.close(); }
    },
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    nodeVersion: process.version,
  };
}
