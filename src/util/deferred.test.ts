import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deferred } from './deferred.ts';

describe('deferred', () => {
  it('settles its promise from the outside', async () => {
    const value = deferred<number>();
    value.release(7);
    assert.equal(await value.promise, 7);

    const failure = deferred<void>();
    failure.reject(new Error('no'));
    await assert.rejects(failure.promise, /no/);

    const signal = deferred();
    signal.resolve();
    assert.equal(await signal.promise, undefined);
  });
});
