/**
 * Keeps the live suite honest: every registered action must be mapped to an existing live test
 * file, and the manifest must not name actions that no longer exist. Runs without a Sonos system.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createActionRegistry } from '../../src/actions/index.ts';
import { MANIFEST } from './manifest.ts';

describe('live coverage manifest', () => {
  const registered = createActionRegistry({ cacheDir: '/tmp' }).names();
  const files = new Set(readdirSync(import.meta.dirname).filter((f) => f.endsWith('.test.ts')));

  it('covers every registered action', () => {
    const missing = registered.filter((name) => !(name in MANIFEST));
    assert.deepEqual(missing, [], 'actions without a live test');
  });

  it('names only registered actions and existing test files', () => {
    const stale = Object.keys(MANIFEST).filter((name) => !registered.includes(name));
    assert.deepEqual(stale, [], 'manifest entries for actions that no longer exist');

    const dangling = Object.entries(MANIFEST)
      .filter(([, coverage]) => !files.has(coverage.file))
      .map(([name, coverage]) => `${name} -> ${coverage.file}`);
    assert.deepEqual(dangling, [], 'manifest entries pointing at missing files');
  });
});
