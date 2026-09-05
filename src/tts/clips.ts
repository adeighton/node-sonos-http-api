import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { fileDurationMs } from './duration.ts';
import type { Clip } from './provider.ts';

/** Pre-recorded clips (doorbells, chimes) under `static/clips`. */
export interface ClipLibrary {
  get(name: string): Promise<Clip>;
}

export interface ClipLibraryOptions {
  dir: string;
  /** URL prefix players use to fetch them. Default `/clips`. */
  publicPath?: string;
  measureDuration?: (file: string) => Promise<number>;
}

export function createClipLibrary(options: ClipLibraryOptions): ClipLibrary {
  const publicPath = options.publicPath ?? '/clips';
  const measureDuration = options.measureDuration ?? fileDurationMs;

  return {
    async get(name) {
      if (name === '' || basename(name) !== name || name.startsWith('.')) {
        throw new BadRequestError(
          `Clip names are plain file names inside the clips folder, got '${name}'`,
        );
      }

      const file = join(options.dir, name);
      try {
        await access(file);
      } catch {
        throw new NotFoundError(`No clip named '${name}' in ${options.dir}`);
      }

      return {
        uri: `${publicPath}/${encodeURIComponent(name)}`,
        durationMs: await measureDuration(file),
      };
    },
  };
}
