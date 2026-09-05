import { watch as fsWatch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import JSON5 from 'json5';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { parsePreset } from './types.ts';
import type { Preset } from './types.ts';

/** Watches a directory and calls `onChange` for any change; returns a handle to stop watching. */
export type WatchDirectory = (dir: string, onChange: () => void) => { close(): void };

export interface PresetStoreOptions {
  logger?: Logger;
  watch?: WatchDirectory;
  /** Coalesces bursts of file events (editors write several times). Default 200 ms. */
  debounceMs?: number;
}

const defaultWatch: WatchDirectory = (dir, onChange) => {
  const watcher = fsWatch(dir, { persistent: false }, () => onChange());
  return { close: () => watcher.close() };
};

/** Loads `<dir>/*.json` (JSON5) presets, keyed by file name, and reloads them when the directory changes. */
export class PresetStore {
  readonly dir: string;
  readonly #logger: Logger;
  readonly #watch: WatchDirectory;
  readonly #debounceMs: number;
  #presets = new Map<string, Preset>();
  #watcher: { close(): void } | undefined;
  #reloadTimer: NodeJS.Timeout | undefined;
  #loading: Promise<void> | undefined;

  constructor(dir: string, options: PresetStoreOptions = {}) {
    this.dir = dir;
    this.#logger = options.logger ?? silentLogger;
    this.#watch = options.watch ?? defaultWatch;
    this.#debounceMs = options.debounceMs ?? 200;
  }

  /** Reads every preset file; invalid files are logged and skipped, a missing directory yields none. */
  load(): Promise<void> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  get(name: string): Preset | undefined {
    return this.#presets.get(name);
  }

  names(): string[] {
    return [...this.#presets.keys()].sort((a, b) => a.localeCompare(b));
  }

  /** Starts reloading on directory changes; a directory that cannot be watched is only logged. */
  watch(): void {
    if (this.#watcher) {
      return;
    }

    try {
      this.#watcher = this.#watch(this.dir, () => this.#scheduleReload());
    } catch (error) {
      this.#logger.warn(
        { err: error, dir: this.dir },
        'could not watch the preset directory, presets will not auto-reload',
      );
    }
  }

  close(): void {
    clearTimeout(this.#reloadTimer);
    this.#reloadTimer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  #scheduleReload(): void {
    clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined;
      void this.load();
    }, this.#debounceMs);
  }

  async #load(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (error) {
      this.#logger.warn({ err: error, dir: this.dir }, 'could not read the preset directory');
      this.#presets = new Map();
      return;
    }

    const presets = new Map<string, Preset>();
    for (const entry of entries.filter((name) => !name.startsWith('.') && extname(name) === '.json')) {
      const name = basename(entry, '.json');
      const file = join(this.dir, entry);
      try {
        const preset = parsePreset(JSON5.parse(await readFile(file, 'utf8')), `preset ${name}`);
        presets.set(name, preset);
      } catch (error) {
        this.#logger.warn({ err: error, file }, 'skipping invalid preset file');
      }
    }

    this.#presets = presets;
    this.#logger.info({ presets: [...presets.keys()].sort() }, 'presets loaded');
  }
}
