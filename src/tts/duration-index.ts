/**
 * Remembers how long each clip is, so a cached clip never has to be parsed again. Kept in memory
 * and persisted as one small JSON file next to the clips; losing it only costs a re-measure.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { fileDurationMs } from './duration.ts';

export interface DurationIndexOptions {
  /** The JSON file the index is saved to. */
  file: string;
  measure?: (path: string) => Promise<number>;
  logger?: Logger;
  /** How long to coalesce writes; default 250 ms. */
  writeDelayMs?: number;
}

export class DurationIndex {
  readonly #file: string;
  readonly #measure: (path: string) => Promise<number>;
  readonly #logger: Logger;
  readonly #writeDelayMs: number;
  readonly #durations = new Map<string, number>();
  readonly #measuring = new Map<string, Promise<number>>();
  #writeTimer: NodeJS.Timeout | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: DurationIndexOptions) {
    this.#file = options.file;
    this.#measure = options.measure ?? fileDurationMs;
    this.#logger = options.logger ?? silentLogger;
    this.#writeDelayMs = options.writeDelayMs ?? 250;
  }

  /** Reads the saved index; a missing or unreadable file just means starting empty. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }

      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          this.#durations.set(name, value);
        }
      }
    } catch (error) {
      this.#logger.warn({ err: error, file: this.#file }, 'ignoring duration index, unreadable');
    }
  }

  get(filename: string): number | undefined {
    return this.#durations.get(filename);
  }

  /** Records a duration learned some other way (e.g. from the frames just written). */
  set(filename: string, durationMs: number): void {
    this.#durations.set(filename, durationMs);
    this.#scheduleWrite();
  }

  /** The duration of `filename` at `path`, measured at most once. */
  async resolve(path: string, filename: string): Promise<number> {
    const known = this.#durations.get(filename);
    if (known !== undefined) {
      return known;
    }

    let pending = this.#measuring.get(filename);
    if (!pending) {
      pending = this.#measure(path)
        .then((duration) => {
          this.set(filename, duration);
          return duration;
        })
        .finally(() => this.#measuring.delete(filename));
      this.#measuring.set(filename, pending);
    }

    return pending;
  }

  /** Writes any pending changes now. */
  async flush(): Promise<void> {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = undefined;
      this.#write();
    }

    await this.#writing;
  }

  #scheduleWrite(): void {
    if (this.#writeTimer) {
      return;
    }

    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = undefined;
      this.#write();
    }, this.#writeDelayMs);
    this.#writeTimer.unref();
  }

  #write(): void {
    const snapshot = JSON.stringify(Object.fromEntries(this.#durations), null, 0);
    const temporary = `${this.#file}.part`;
    this.#writing = this.#writing
      .then(() => writeFile(temporary, snapshot))
      .then(() => rename(temporary, this.#file))
      .catch((error: unknown) => {
        this.#logger.warn({ err: error, file: this.#file }, 'could not save the duration index');
      });
  }
}
