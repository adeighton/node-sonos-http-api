import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { withTempDir } from './with-temp-dir.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('withTempDir', () => {
  it('provides a writable directory and removes it afterwards', async () => {
    let seen = '';
    const result = await withTempDir(async (dir) => {
      seen = dir;
      await writeFile(join(dir, 'file.txt'), 'hello');
      assert.ok(await exists(join(dir, 'file.txt')));
      return 42;
    });

    assert.equal(result, 42);
    assert.ok(seen.length > 0);
    assert.equal(await exists(seen), false);
  });

  it('removes the directory when the callback throws', async () => {
    let seen = '';
    await assert.rejects(
      withTempDir((dir) => {
        seen = dir;
        return Promise.reject(new Error('boom'));
      }),
      /boom/,
    );

    assert.equal(await exists(seen), false);
  });
});
