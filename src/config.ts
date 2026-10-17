/**
 * Config resolution. Precedence, highest first:
 *   CLI flag → env var → config file → platform default
 *
 * No hardcoded paths anywhere. Beyond tidiness this is what lets the tool work
 * with non-default harness installs, lets the archive live on an external or
 * encrypted volume, and lets the whole pipeline be tested against fixture
 * directories instead of the real home directory.
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';

export type Config = {
  /** Transcript source directories, searched for *.jsonl. */
  sources: string[];
  /**
   * Durable store: the catalog, findings, SQLite. **No transcript copies.**
   * Deliberately NOT the plugin data dir — it must survive plugin uninstall and
   * be shared with the CLI, because two stores would mean two different answers.
   */
  archive: string;
  /**
   * Large, disposable, re-downloadable. Lives in the plugin data dir when
   * running as a plugin so it is removed on uninstall.
   */
  models: string;
  configFile: string | undefined;
};

/** Where each value came from, so `agentsensei config` can show its work. */
export type Provenance = Record<keyof Omit<Config, 'configFile'>, Layer>;
export type Layer = 'flag' | 'env' | 'file' | 'default';

export type ResolveInput = {
  flags?: {
    sources?: string[];
    archive?: string;
    models?: string;
    config?: string;
  };
  env?: NodeJS.ProcessEnv;
  home?: string;
};

/**
 * Directories we would rather not put our store inside.
 *
 * This used to be load-bearing, when the archive held raw transcripts. It no
 * longer does — we copy nothing — so this is ordinary hygiene: the catalog still
 * records absolute paths, and findings still hold redacted excerpts, neither of
 * which belongs in someone's cloud drive by accident.
 */
const SYNC_ROOT_MARKERS = [
  join('Library', 'Mobile Documents'), // iCloud Drive
  'Dropbox',
  'Google Drive',
  'OneDrive',
  join('Library', 'CloudStorage'),
];

export function isInsideSyncRoot(path: string, home = homedir()): boolean {
  const abs = resolve(path);
  return SYNC_ROOT_MARKERS.some((m) => {
    const marker = join(home, m);
    return abs === marker || abs.startsWith(marker + sep);
  });
}

function xdg(env: NodeJS.ProcessEnv, key: string, fallback: string, home: string): string {
  const v = env[key];
  return v && v.trim() !== '' ? v : join(home, fallback);
}

function splitList(v: string | undefined): string[] | undefined {
  if (!v || v.trim() === '') return undefined;
  return v
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function resolveConfig(input: ResolveInput = {}): {
  config: Config;
  provenance: Provenance;
} {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const flags = input.flags ?? {};

  const configFile =
    flags.config ??
    env['AGENTSENSEI_CONFIG'] ??
    join(xdg(env, 'XDG_CONFIG_HOME', '.config', home), 'agentsensei', 'config.json');

  let fromFile: Partial<Config> = {};
  try {
    const raw = readFileSync(configFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    if (parsed && typeof parsed === 'object') fromFile = parsed;
  } catch {
    // Absent or unreadable config is normal, not an error.
  }

  const dataHome = xdg(env, 'XDG_DATA_HOME', join('.local', 'share'), home);

  const pick = <K extends keyof Omit<Config, 'configFile'>>(
    key: K,
    flagVal: Config[K] | undefined,
    envVal: Config[K] | undefined,
    def: Config[K],
  ): [Config[K], Layer] => {
    if (flagVal !== undefined) return [flagVal, 'flag'];
    if (envVal !== undefined) return [envVal, 'env'];
    const fileVal = fromFile[key];
    if (fileVal !== undefined) return [fileVal as Config[K], 'file'];
    return [def, 'default'];
  };

  const [sources, pSources] = pick(
    'sources',
    flags.sources,
    splitList(env['AGENTSENSEI_SOURCES']),
    [join(home, '.claude', 'projects'), join(home, '.codex', 'sessions')],
  );

  const [archive, pArchive] = pick(
    'archive',
    flags.archive,
    env['AGENTSENSEI_ARCHIVE'],
    join(dataHome, 'agentsensei'),
  );

  // As a plugin, Claude Code hands us a per-plugin data dir. Models go there so
  // they are removed on uninstall; the archive never does.
  const [models, pModels] = pick(
    'models',
    flags.models,
    env['AGENTSENSEI_MODELS'],
    env['CLAUDE_PLUGIN_DATA']
      ? join(env['CLAUDE_PLUGIN_DATA'], 'models')
      : join(archive, 'models'),
  );

  return {
    config: { sources, archive, models, configFile },
    provenance: { sources: pSources, archive: pArchive, models: pModels },
  };
}
