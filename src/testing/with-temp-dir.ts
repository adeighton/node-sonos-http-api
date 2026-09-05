import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs `fn` with a fresh temporary directory that is removed afterwards, even on failure. */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
  prefix = 'sonos-http-api-test-',
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
