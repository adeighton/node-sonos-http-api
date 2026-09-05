import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flushPromises } from './async.ts';

describe('flushPromises', () => {
  it('lets chained promise callbacks complete', async () => {
    let value = 0;
    void Promise.resolve()
      .then(() => {
        value = 1;
      })
      .then(() => {
        value = 2;
      });

    assert.equal(value, 0);
    await flushPromises();
    assert.equal(value, 2);
  });
});
