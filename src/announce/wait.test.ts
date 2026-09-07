import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { flushPromises } from '../testing/async.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { waitForClipEnd, waitForTopology } from './wait.ts';

describe('waitForTopology', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('resolves at once when the zones already match, without listening', async () => {
    const system = new FakeSystem();
    const baseline = system.listenerCount('topology-change');
    assert.equal(await waitForTopology(system, () => true, { timeoutMs: 1000 }), 'matched');
    assert.equal(system.listenerCount('topology-change'), baseline);
  });

  it('resolves on the first matching topology event and stops listening', async () => {
    const system = new FakeSystem();
    const baseline = system.listenerCount('topology-change');
    let calls = 0;
    const pending = waitForTopology(system, (zones) => zones.length === 2, { timeoutMs: 1000 });
    system.on('topology-change', () => {
      calls += 1;
    });

    system.emit('topology-change', []);
    await flushPromises();
    const a = system.addStandalone(createTestPlayer({ system, roomName: 'A', uuid: 'A' }).player);
    const b = system.addStandalone(createTestPlayer({ system, roomName: 'B', uuid: 'B' }).player);
    system.emit('topology-change', [a, b]);

    assert.equal(await pending, 'matched');
    assert.equal(calls, 2);
    assert.equal(
      system.listenerCount('topology-change'),
      baseline + 1,
      'only the test listener is left',
    );
  });

  it('gives up after the timeout, or when aborted', async () => {
    const system = new FakeSystem();
    const baseline = system.listenerCount('topology-change');
    const slow = waitForTopology(system, () => false, { timeoutMs: 500 });
    mock.timers.tick(500);
    assert.equal(await slow, 'timeout');

    const controller = new AbortController();
    const aborted = waitForTopology(system, () => false, {
      timeoutMs: 500,
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(await aborted, 'aborted');
    assert.equal(system.listenerCount('topology-change'), baseline);
  });
});

describe('waitForClipEnd', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  it('ends when the player reports STOPPED after having played', async () => {
    const { player } = createTestPlayer();
    const pending = waitForClipEnd(player, { durationMs: 5000 });
    assert.equal(player.listenerCount('playback-state'), 1, 'listens before anything else runs');

    player.emit('playback-state', 'STOPPED');
    await flushPromises();
    player.emit('playback-state', 'PLAYING');
    player.emit('playback-state', 'PAUSED_PLAYBACK');
    player.emit('playback-state', 'TRANSITIONING');
    player.emit('playback-state', 'STOPPED');

    assert.equal(await pending, 'stopped');
    assert.equal(player.listenerCount('playback-state'), 0);
  });

  it('ignores a stale STOPPED only within the grace period', async () => {
    const { player } = createTestPlayer();
    const pending = waitForClipEnd(player, { durationMs: 5000, graceMs: 1000 });
    mock.timers.tick(999);
    player.emit('playback-state', 'STOPPED');
    await flushPromises();
    mock.timers.tick(1);
    player.emit('playback-state', 'STOPPED');
    assert.equal(await pending, 'stopped');
  });

  it('gives up after the duration plus the margin, or when aborted', async () => {
    const { player } = createTestPlayer();
    const slow = waitForClipEnd(player, { durationMs: 3000, marginMs: 2000 });
    mock.timers.tick(4999);
    await flushPromises();
    player.emit('playback-state', 'PLAYING');
    mock.timers.tick(1);
    assert.equal(await slow, 'timeout');

    const controller = new AbortController();
    const aborted = waitForClipEnd(player, { durationMs: 3000, signal: controller.signal });
    controller.abort();
    assert.equal(await aborted, 'aborted');
    assert.equal(player.listenerCount('playback-state'), 0);

    const early = new AbortController();
    early.abort();
    assert.equal(await waitForClipEnd(player, { durationMs: 1, signal: early.signal }), 'aborted');
  });
});
