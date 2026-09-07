import { randomBytes } from 'node:crypto';
import { access, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { DurationIndex } from './duration-index.ts';
import type { Clip } from './provider.ts';

export interface ClipCacheOptions {
  /** Directory the clips live in (served as `publicPath`). */
  dir: string;
  /** URL prefix players use to fetch them. Default `/tts`. */
  publicPath?: string;
  logger?: Logger;
  /** Remembered durations; defaults to `durations.json` inside `dir`. */
  durations?: DurationIndex;
}

export interface CachedClip extends Clip {
  cached: boolean;
}

/**
 * Producer of a clip: writes the audio to `temporaryPath` and may return its duration in
 * milliseconds when it already knows it, saving a parse of the file.
 */
export type ClipWriter = (temporaryPath: string) => Promise<number | undefined | void>;

/**
 * Keeps generated speech on disk so the same phrase is only synthesized once. New files are
 * written to a temporary name and renamed into place, so a crash mid-write never leaves a
 * truncated clip that a player would fetch. Concurrent requests for the same clip share one
 * synthesis, and durations are remembered so cached clips are never parsed again.
 */
export class ClipCache {
  readonly dir: string;
  readonly #publicPath: string;
  readonly #logger: Logger;
  readonly #durations: DurationIndex;
  readonly #ready: Promise<void>;
  readonly #inFlight = new Map<string, Promise<CachedClip>>();

  constructor(options: ClipCacheOptions) {
    this.dir = options.dir;
    this.#publicPath = options.publicPath ?? '/tts';
    this.#logger = options.logger ?? silentLogger;
    this.#durations =
      options.durations ??
      new DurationIndex({ file: join(options.dir, 'durations.json'), logger: this.#logger });
    this.#ready = this.#durations.load();
  }

  /** Returns the cached clip, or produces it through `write(temporaryPath)` first. */
  getOrCreate(filename: string, write: ClipWriter): Promise<CachedClip> {
    const pending = this.#inFlight.get(filename);
    if (pending) {
      return pending;
    }

    const created = this.#getOrCreate(filename, write).finally(() => {
      this.#inFlight.delete(filename);
    });
    this.#inFlight.set(filename, created);
    return created;
  }

  async #getOrCreate(filename: string, write: ClipWriter): Promise<CachedClip> {
    await this.#ready;
    const file = join(this.dir, filename);
    const uri = `${this.#publicPath}/${encodeURIComponent(filename)}`;

    if (await this.#exists(file)) {
      this.#logger.debug({ file }, 'using cached clip');
      return { uri, durationMs: await this.#durations.resolve(file, filename), cached: true };
    }

    const temporary = `${file}.${randomBytes(6).toString('hex')}.part`;
    let durationMs: number | undefined;
    try {
      const known = await write(temporary);
      durationMs = typeof known === 'number' ? known : undefined;
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    if (durationMs !== undefined) {
      this.#durations.set(filename, durationMs);
    } else {
      durationMs = await this.#durations.resolve(file, filename);
    }

    this.#logger.info({ file, durationMs }, 'generated clip');
    return { uri, durationMs, cached: false };
  }

  async #exists(file: string): Promise<boolean> {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }
}
