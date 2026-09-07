import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLimiter, mapLimit } from './parallel.ts';

/** A task that resolves when told to, recording how many run at once. */
function gate() {
  let running = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const task = (value: number) =>
    new Promise<number>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      release.push(() => {
        running -= 1;
        resolve(value * 2);
      });
    });
  const releaseAll = async () => {
    while (release.length > 0) {
      release.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { task, releaseAll, peak: () => peak, running: () => running };
}

describe('mapLimit', () => {
  it('runs at most `limit` tasks at once and keeps result order', async () => {
    const g = gate();
    const pending = mapLimit([1, 2, 3, 4, 5], 2, g.task);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(g.running(), 2, 'only two started');

    await g.releaseAll();
    const results = await pending;

    assert.equal(g.peak(), 2);
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value : 'rejected')),
      [2, 4, 6, 8, 10],
    );
  });

  it('reports rejections in place without stopping the others', async () => {
    const results = await mapLimit([1, 2, 3], 3, (n) =>
      n === 2 ? Promise.reject(new Error('two')) : Promise.resolve(n),
    );
    assert.equal(results[0]?.status, 'fulfilled');
    const second = results[1];
    assert.ok(second?.status === 'rejected');
    assert.equal((second.reason as Error).message, 'two');
    assert.equal(results[2]?.status, 'fulfilled');
  });

  it('handles an empty list and a limit larger than the list', async () => {
    assert.deepEqual(await mapLimit([], 4, () => Promise.resolve(1)), []);
    const results = await mapLimit([1], 10, (n) => Promise.resolve(n));
    assert.equal(results.length, 1);
  });
});

describe('createLimiter', () => {
  it('lets at most `max` tasks run concurrently, first come first served', async () => {
    const g = gate();
    const limit = createLimiter(2);
    const pending = [1, 2, 3].map((n) => limit(() => g.task(n)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(g.running(), 2);

    await g.releaseAll();
    assert.deepEqual(await Promise.all(pending), [2, 4, 6]);
    assert.equal(g.peak(), 2);
  });

  it('releases the slot when a task throws', async () => {
    const limit = createLimiter(1);
    await assert.rejects(
      limit(() => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(await limit(() => Promise.resolve('next')), 'next');
  });
});
