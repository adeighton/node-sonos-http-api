import { randomBytes } from 'node:crypto';
import { access, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { fileDurationMs } from './duration.ts';
import type { Clip } from './provider.ts';

export interface ClipCacheOptions {
  /** Directory the clips live in (served as `publicPath`). */
  dir: string;
  /** URL prefix players use to fetch them. Default `/tts`. */
  publicPath?: string;
  logger?: Logger;
  measureDuration?: (file: string) => Promise<number>;
}

/**
 * Keeps generated speech on disk so the same phrase is only synthesized once. New files are
 * written to a temporary name and renamed into place, so a crash mid-write never leaves a
 * truncated clip that a player would fetch.
 */
export class ClipCache {
  readonly dir: string;
  readonly #publicPath: string;
  readonly #logger: Logger;
  readonly #measureDuration: (file: string) => Promise<number>;

  constructor(options: ClipCacheOptions) {
    this.dir = options.dir;
    this.#publicPath = options.publicPath ?? '/tts';
    this.#logger = options.logger ?? silentLogger;
    this.#measureDuration = options.measureDuration ?? fileDurationMs;
  }

  /** Returns the cached clip, or produces it through `write(temporaryPath)` first. */
  async getOrCreate(
    filename: string,
    write: (temporaryPath: string) => Promise<void>,
  ): Promise<Clip> {
    const file = join(this.dir, filename);
    const uri = `${this.#publicPath}/${encodeURIComponent(filename)}`;

    if (await this.#exists(file)) {
      this.#logger.debug({ file }, 'using cached clip');
      return { uri, durationMs: await this.#measureDuration(file) };
    }

    const temporary = `${file}.${randomBytes(6).toString('hex')}.part`;
    try {
      await write(temporary);
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    this.#logger.info({ file }, 'generated clip');
    return { uri, durationMs: await this.#measureDuration(file) };
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
