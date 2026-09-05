import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { fixturePath } from '../testing/fixtures.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { createClipLibrary } from './clips.ts';

describe('createClipLibrary', () => {
  it('resolves clips in the folder with their duration and rejects the rest', async () => {
    await withTempDir(async (dir) => {
      await copyFile(fixturePath('clip.mp3'), join(dir, 'ding dong.mp3'));
      const library = createClipLibrary({ dir });

      const clip = await library.get('ding dong.mp3');
      assert.equal(clip.uri, '/clips/ding%20dong.mp3');
      assert.ok(clip.durationMs > 0);

      await assert.rejects(library.get('missing.mp3'), NotFoundError);
      await assert.rejects(library.get('../package.json'), BadRequestError);
      await assert.rejects(library.get('.hidden.mp3'), BadRequestError);
      await assert.rejects(library.get(''), BadRequestError);
    });
  });

  it('honours a custom public path and duration measurement', async () => {
    await withTempDir(async (dir) => {
      await copyFile(fixturePath('clip.mp3'), join(dir, 'a.mp3'));
      const library = createClipLibrary({
        dir,
        publicPath: '/sounds',
        measureDuration: () => Promise.resolve(42),
      });

      assert.deepEqual(await library.get('a.mp3'), { uri: '/sounds/a.mp3', durationMs: 42 });
    });
  });
});
