/** Config resolution: CLI flag → env var → config file → platform default. No hardcoded paths. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Preset } from './types.ts';

export type Config = {
  /** Transcript source directories, searched for *.jsonl. */
  sources: string[];
  /** Durable store (catalog, SQLite), never transcript copies. Not the plugin data dir: it outlives uninstall. */
  archive: string;
  /** Which dimensions run by default. `core` admits by precision, never frequency. */
  preset: Preset;
  /** Dimensions to silence: not computed, counted or mentioned. Unknown names are reported. */
  mute: string[];
  configFile: string | undefined;
};

/** Where each value came from, so `vibesenpai config` can show its work. */
export type Provenance = Record<keyof Omit<Config, 'configFile'>, Layer>;
export type Layer = 'flag' | 'env' | 'file' | 'default';

type ResolveInput = {
  flags?: {
    sources?: string[];
    archive?: string;
    config?: string;
    preset?: string;
    mute?: string[];
  };
  env?: NodeJS.ProcessEnv;
  home?: string;
};

const PRESETS: readonly Preset[] = ['core', 'standard', 'all'];

/** A preset name, or undefined so the layer falls through and the rejection is reported. */
function asPreset(v: unknown): Preset | undefined {
  return typeof v === 'string' && (PRESETS as readonly string[]).includes(v)
    ? (v as Preset)
    : undefined;
}


/** Claude Code's own directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const v = env['CLAUDE_CONFIG_DIR'];
  return v && v.trim() !== '' ? v : join(home, '.claude');
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
  /** Values that were rejected, so a typo is visible instead of silent. */
  warnings: string[];
} {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const flags = input.flags ?? {};

  const configFile =
    flags.config ??
    env['VIBESENPAI_CONFIG'] ??
    join(xdg(env, 'XDG_CONFIG_HOME', '.config', home), 'vibesenpai', 'config.json');

  let fromFile: Partial<Config> = {};
  try {
    const raw = readFileSync(configFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    if (parsed && typeof parsed === 'object') fromFile = parsed;
  } catch {
    // Absent or unreadable config is normal, not an error.
  }

  const dataHome = xdg(env, 'XDG_DATA_HOME', join('.local', 'share'), home);
  const warnings: string[] = [];

  for (const [layer, raw] of [
    ['--preset', input.flags?.preset],
    ['VIBESENPAI_PRESET', env['VIBESENPAI_PRESET']],
    ['config file', fromFile.preset],
  ] as const) {
    if (raw !== undefined && asPreset(raw) === undefined) {
      warnings.push(`${layer}: "${String(raw)}" is not a preset (${PRESETS.join(', ')}) — ignored`);
    }
  }

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
    splitList(env['VIBESENPAI_SOURCES']),
    [join(claudeDir(env, home), 'projects'), join(home, '.codex', 'sessions')],
  );

  const [archive, pArchive] = pick(
    'archive',
    flags.archive,
    env['VIBESENPAI_ARCHIVE'],
    join(dataHome, 'vibesenpai'),
  );

  const [preset, pPreset] = pick(
    'preset',
    asPreset(input.flags?.preset),
    asPreset(env['VIBESENPAI_PRESET']),
    'core',
  );

  const [mute, pMute] = pick(
    'mute',
    input.flags?.mute,
    splitList(env['VIBESENPAI_MUTE']),
    [],
  );

  return {
    config: { sources, archive, preset, mute, configFile },
    provenance: {
      sources: pSources,
      archive: pArchive,
      preset: pPreset,
      mute: pMute,
    },
    warnings,
  };
}
