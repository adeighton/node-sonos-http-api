import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { withTempDir } from '../testing/with-temp-dir.ts';
import { ClipCache } from './cache.ts';

describe('ClipCache', () => {
  it('produces a clip once, atomically, and serves it from the cache afterwards', async () => {
    await withTempDir(async (dir) => {
      const measureDuration = mock.fn((_file: string) => Promise.resolve(1500));
      const cache = new ClipCache({ dir, measureDuration });
      const write = mock.fn(async (temporary: string) => {
        assert.ok(temporary.endsWith('.part'));
        assert.deepEqual(await readdir(dir), [], 'nothing is visible before the write completes');
        await writeFile(temporary, 'mp3 bytes');
      });

      const first = await cache.getOrCreate('polly-abc.mp3', write);
      const second = await cache.getOrCreate('polly-abc.mp3', write);

      assert.deepEqual(first, { uri: '/tts/polly-abc.mp3', durationMs: 1500 });
      assert.deepEqual(second, first);
      assert.equal(write.mock.callCount(), 1);
      assert.deepEqual(await readdir(dir), ['polly-abc.mp3']);
      assert.equal(await readFile(join(dir, 'polly-abc.mp3'), 'utf8'), 'mp3 bytes');
      assert.equal(measureDuration.mock.calls[0]?.arguments[0], join(dir, 'polly-abc.mp3'));
    });
  });

  it('removes the partial file and rethrows when producing fails', async () => {
    await withTempDir(async (dir) => {
      const cache = new ClipCache({ dir, measureDuration: () => Promise.resolve(1) });

      await assert.rejects(
        cache.getOrCreate('bad.mp3', async (temporary) => {
          await writeFile(temporary, 'partial');
          throw new Error('synthesis failed');
        }),
        /synthesis failed/,
      );

      assert.deepEqual(await readdir(dir), []);
    });
  });

  it('url-encodes the file name in the uri and honours a custom public path', async () => {
    await withTempDir(async (dir) => {
      const cache = new ClipCache({
        dir,
        publicPath: '/speech',
        measureDuration: () => Promise.resolve(1),
      });

      const clip = await cache.getOrCreate('a b&c.mp3', (temporary) => writeFile(temporary, 'x'));

      assert.equal(clip.uri, '/speech/a%20b%26c.mp3');
    });
  });
});
