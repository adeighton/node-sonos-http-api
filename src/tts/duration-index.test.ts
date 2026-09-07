import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { DurationIndex } from './duration-index.ts';

describe('DurationIndex', () => {
  it('measures a file once, then answers from memory and from the saved index', async () => {
    await withTempDir(async (dir) => {
      const measure = mock.fn((_path: string) => Promise.resolve(1234));
      const index = new DurationIndex({ file: join(dir, 'durations.json'), measure });
      await index.load();

      assert.equal(index.get('a.mp3'), undefined);
      assert.equal(await index.resolve(join(dir, 'a.mp3'), 'a.mp3'), 1234);
      assert.equal(await index.resolve(join(dir, 'a.mp3'), 'a.mp3'), 1234);
      assert.equal(measure.mock.callCount(), 1, 'measured once');
      assert.equal(index.get('a.mp3'), 1234);

      await index.flush();
      const saved = JSON.parse(await readFile(join(dir, 'durations.json'), 'utf8')) as Record<
        string,
        number
      >;
      assert.deepEqual(saved, { 'a.mp3': 1234 });

      const reopened = new DurationIndex({
        file: join(dir, 'durations.json'),
        measure: () => Promise.reject(new Error('should not measure')),
      });
      await reopened.load();
      assert.equal(await reopened.resolve(join(dir, 'a.mp3'), 'a.mp3'), 1234);
    });
  });

  it('accepts a known duration directly and coalesces the write', async () => {
    await withTempDir(async (dir) => {
      const index = new DurationIndex({
        file: join(dir, 'durations.json'),
        measure: () => Promise.reject(new Error('should not measure')),
      });
      await index.load();
      index.set('x.mp3', 10);
      index.set('y.mp3', 20);
      await index.flush();

      const saved = JSON.parse(await readFile(join(dir, 'durations.json'), 'utf8'));
      assert.deepEqual(saved, { 'x.mp3': 10, 'y.mp3': 20 });
    });
  });

  it('starts empty and warns when the saved index is unreadable', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'durations.json');
      await writeFile(file, '{ not json');
      const logs = captureLogs();
      const index = new DurationIndex({
        file,
        measure: () => Promise.resolve(5),
        logger: logs.logger,
      });
      await index.load();

      assert.equal(index.get('anything'), undefined);
      assert.ok(logs.messages().some((m) => m.includes('ignoring duration index')));
      assert.equal(await index.resolve(join(dir, 'z.mp3'), 'z.mp3'), 5);
    });
  });

  it('measures once even when asked concurrently', async () => {
    await withTempDir(async (dir) => {
      const measure = mock.fn((_path: string) => Promise.resolve(42));
      const index = new DurationIndex({ file: join(dir, 'durations.json'), measure });
      await index.load();

      const both = await Promise.all([
        index.resolve(join(dir, 'c.mp3'), 'c.mp3'),
        index.resolve(join(dir, 'c.mp3'), 'c.mp3'),
      ]);
      assert.deepEqual(both, [42, 42]);
      assert.equal(measure.mock.callCount(), 1);
    });
  });
});
