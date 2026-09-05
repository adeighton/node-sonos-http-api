import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fixturePath, readFixture, readJsonFixture } from './fixtures.ts';

describe('fixtures helper', () => {
  it('resolves paths under test/fixtures', () => {
    assert.match(fixturePath('queue.xml'), /test\/fixtures\/queue\.xml$/);
  });

  it('reads text and JSON fixtures, returning fresh JSON objects', () => {
    assert.ok(readFixture('addURIToQueue.xml').includes('AddURIToQueueResponse'));

    const first = readJsonFixture<{ transportstate: { val: string } }>(
      'avtransportlastchange.json',
    );
    first.transportstate.val = 'MUTATED';
    const second = readJsonFixture<{ transportstate: { val: string } }>(
      'avtransportlastchange.json',
    );
    assert.equal(second.transportstate.val, 'PLAYING');
  });
});
