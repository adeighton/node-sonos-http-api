import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fixturePath } from '../testing/fixtures.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { fileDurationMs } from './duration.ts';

describe('fileDurationMs', () => {
  it('measures a real mp3 clip', async () => {
    const duration = await fileDurationMs(fixturePath('clip.mp3'));

    assert.ok(duration > 500 && duration < 10_000, `unexpected duration ${duration}`);
    assert.equal(Number.isInteger(duration), true);
  });

  it('rejects files that are not audio', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'note.mp3');
      await writeFile(file, 'not audio at all');

      await assert.rejects(fileDurationMs(file));
    });
  });
});
