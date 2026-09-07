import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { withTempDir } from '../testing/with-temp-dir.ts';
import { ClipCache } from './cache.ts';
import { DurationIndex } from './duration-index.ts';

function durations(dir: string, measure = (_file: string) => Promise.resolve(1500)) {
  const measureDuration = mock.fn(measure);
  return {
    measureDuration,
    index: new DurationIndex({ file: join(dir, 'durations.json'), measure: measureDuration }),
  };
}

describe('ClipCache', () => {
  it('produces a clip once, atomically, and serves it from the cache afterwards', async () => {
    await withTempDir(async (dir) => {
      const { index, measureDuration } = durations(dir);
      const cache = new ClipCache({ dir, durations: index });
      const write = mock.fn(async (temporary: string) => {
        assert.ok(temporary.endsWith('.part'));
        assert.deepEqual(await readdir(dir), [], 'nothing is visible before the write completes');
        await writeFile(temporary, 'mp3 bytes');
      });

      const first = await cache.getOrCreate('polly-abc.mp3', write);
      const second = await cache.getOrCreate('polly-abc.mp3', write);

      assert.deepEqual(first, { uri: '/tts/polly-abc.mp3', durationMs: 1500, cached: false });
      assert.deepEqual(second, { uri: '/tts/polly-abc.mp3', durationMs: 1500, cached: true });
      assert.equal(write.mock.callCount(), 1);
      assert.equal(measureDuration.mock.callCount(), 1, 'the duration is measured once');
      assert.ok((await readdir(dir)).includes('polly-abc.mp3'));
      assert.equal(await readFile(join(dir, 'polly-abc.mp3'), 'utf8'), 'mp3 bytes');
      assert.equal(measureDuration.mock.calls[0]?.arguments[0], join(dir, 'polly-abc.mp3'));
    });
  });

  it('remembers durations across instances through the index file', async () => {
    await withTempDir(async (dir) => {
      const first = durations(dir);
      const cache = new ClipCache({ dir, durations: first.index });
      await cache.getOrCreate('a.mp3', (temporary) => writeFile(temporary, 'x'));
      await first.index.flush();

      const second = durations(dir, () => Promise.reject(new Error('must not measure')));
      const reopened = new ClipCache({ dir, durations: second.index });
      const clip = await reopened.getOrCreate('a.mp3', () => Promise.reject(new Error('no')));
      assert.deepEqual(clip, { uri: '/tts/a.mp3', durationMs: 1500, cached: true });
    });
  });

  it('accepts the duration the writer already knows instead of measuring the file', async () => {
    await withTempDir(async (dir) => {
      const { index, measureDuration } = durations(dir, () =>
        Promise.reject(new Error('must not measure')),
      );
      const cache = new ClipCache({ dir, durations: index });

      const clip = await cache.getOrCreate('known.mp3', async (temporary) => {
        await writeFile(temporary, 'x');
        return 4321;
      });

      assert.equal(clip.durationMs, 4321);
      assert.equal(measureDuration.mock.callCount(), 0);
      assert.equal(index.get('known.mp3'), 4321);
    });
  });

  it('synthesizes identical concurrent requests only once', async () => {
    await withTempDir(async (dir) => {
      const { index } = durations(dir);
      const cache = new ClipCache({ dir, durations: index });
      let release: () => void = () => {};
      const write = mock.fn(async (temporary: string) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await writeFile(temporary, 'x');
      });

      const one = cache.getOrCreate('same.mp3', write);
      const two = cache.getOrCreate('same.mp3', write);
      // The writer starts after the index has loaded; wait for it before releasing it.
      while (write.mock.callCount() === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      release();

      const [a, b] = await Promise.all([one, two]);
      assert.equal(write.mock.callCount(), 1);
      assert.deepEqual(a, b);
      assert.equal(a.cached, false);
    });
  });

  it('removes the partial file and rethrows when producing fails', async () => {
    await withTempDir(async (dir) => {
      const cache = new ClipCache({ dir, durations: durations(dir).index });

      await assert.rejects(
        cache.getOrCreate('bad.mp3', async (temporary) => {
          await writeFile(temporary, 'partial');
          throw new Error('synthesis failed');
        }),
        /synthesis failed/,
      );

      assert.ok(!(await readdir(dir)).some((name) => name.startsWith('bad.mp3')));
    });
  });

  it('url-encodes the file name in the uri and honours a custom public path', async () => {
    await withTempDir(async (dir) => {
      const cache = new ClipCache({ dir, publicPath: '/speech', durations: durations(dir).index });

      const clip = await cache.getOrCreate('a b&c.mp3', (temporary) => writeFile(temporary, 'x'));

      assert.equal(clip.uri, '/speech/a%20b%26c.mp3');
    });
  });
});
