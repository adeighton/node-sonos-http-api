import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import JSON5 from 'json5';

import { ConfigError } from './errors.ts';
import { SETTINGS_KEYS, settingsSchema } from './schema.ts';
import type { Settings } from './schema.ts';

/** Environment variable → dotted settings path. Values override settings.json. */
export const ENV_OVERRIDES: ReadonlyArray<readonly [env: string, path: string]> = [
  ['SONOS_HTTP_PORT', 'port'],
  ['SONOS_HTTP_IP', 'ip'],
  ['SONOS_HTTP_SECURE_PORT', 'securePort'],
  ['SONOS_HTTP_AUTH_USERNAME', 'auth.username'],
  ['SONOS_HTTP_AUTH_PASSWORD', 'auth.password'],
  ['SONOS_HOUSEHOLD', 'household'],
  ['SONOS_DISCOVERY_HOSTS', 'discoveryHosts'],
  ['SONOS_ANNOUNCE_VOLUME', 'announceVolume'],
  ['SONOS_WEBHOOK_URL', 'webhook'],
  ['SONOS_POLLY_VOICE', 'aws.voice'],
  ['SONOS_POLLY_ENGINE', 'aws.engine'],
  ['AWS_REGION', 'aws.credentials.region'],
  ['SPOTIFY_CLIENT_ID', 'spotify.clientId'],
  ['SPOTIFY_CLIENT_SECRET', 'spotify.clientSecret'],
  ['SOUNDCLOUD_CLIENT_ID', 'soundcloud'],
  ['LOG_LEVEL', 'logLevel'],
  ['LOG_FORMAT', 'logFormat'],
];

export interface LoadSettingsOptions {
  /** The project root; relative directories in settings resolve against it. */
  rootDir: string;
  /** Defaults to an empty environment so tests are hermetic; pass process.env in production. */
  env?: Record<string, string | undefined>;
  /** Defaults to `<rootDir>/settings.json`. */
  settingsFile?: string;
}

export interface LoadedSettings {
  settings: Settings;
  settingsFile: string;
  fileFound: boolean;
  /** Top-level keys in settings.json the schema does not know (typos, retired providers). */
  unknownKeys: string[];
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPath(target: PlainObject, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (!isPlainObject(next)) {
      const created: PlainObject = {};
      current[key] = created;
      current = created;
    } else {
      current = next;
    }
  }

  current[keys[keys.length - 1] as string] = value;
}

async function readSettingsFile(file: string): Promise<{ raw: PlainObject; found: boolean }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: {}, found: false };
    }

    throw new ConfigError(`Could not read ${file}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(text);
  } catch (error) {
    throw new ConfigError(`Could not parse ${file} as JSON5: ${(error as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object`);
  }

  return { raw: parsed, found: true };
}

export function applyEnvOverrides(raw: PlainObject, env: Record<string, string | undefined>): void {
  for (const [name, path] of ENV_OVERRIDES) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      setPath(
        raw,
        path,
        path === 'discoveryHosts' ? value.split(',').map((host) => host.trim()) : value,
      );
    }
  }

  // AWS credentials stay in the environment (the SDK reads them itself); their presence just
  // switches the Polly provider on.
  if (env.AWS_ACCESS_KEY_ID && !isPlainObject(raw.aws)) {
    raw.aws = {};
  }
}

function resolveDir(rootDir: string, dir: string): string {
  return isAbsolute(dir) ? dir : resolve(rootDir, dir);
}

/** Reads settings.json, applies environment overrides, validates, and resolves directories. */
export async function loadSettings(options: LoadSettingsOptions): Promise<LoadedSettings> {
  const settingsFile = options.settingsFile ?? join(options.rootDir, 'settings.json');
  const { raw, found } = await readSettingsFile(settingsFile);
  const unknownKeys = Object.keys(raw).filter((key) => !SETTINGS_KEYS.includes(key));

  const merged = structuredClone(raw);
  applyEnvOverrides(merged, options.env ?? {});

  const result = settingsSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid settings in ${settingsFile}`, issues);
  }

  const settings: Settings = {
    ...result.data,
    cacheDir: resolveDir(options.rootDir, result.data.cacheDir),
    webroot: resolveDir(options.rootDir, result.data.webroot),
    presetDir: resolveDir(options.rootDir, result.data.presetDir),
  };

  return { settings, settingsFile, fileFound: found, unknownKeys };
}

/** Creates the directories the server writes to (generated TTS clips, music library cache). */
export async function ensureRuntimeDirectories(settings: Settings): Promise<void> {
  await mkdir(join(settings.webroot, 'tts'), { recursive: true });
  await mkdir(settings.cacheDir, { recursive: true });
}
