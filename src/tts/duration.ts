import { parseFile } from 'music-metadata';

/** The playing time of an audio file in whole milliseconds (rounded up). */
export async function fileDurationMs(path: string): Promise<number> {
  const info = await parseFile(path, { duration: true });
  const seconds = info.format.duration;
  if (seconds === undefined) {
    throw new Error(`Could not determine the duration of ${path}`);
  }

  return Math.ceil(seconds * 1000);
}
