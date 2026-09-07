import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Preset } from '../discovery/types.ts';
import { ServiceUnavailableError } from '../http/errors.ts';
import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { deferred } from '../testing/fake-player.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { AnnouncementScheduler } from './scheduler.ts';
import type { AnnouncementSpec, AnnouncementTransition } from './types.ts';

const CLIP = { uri: 'http://127.0.0.1:5005/tts/hi.mp3', durationMs: 2000 };

async function setup(options: { maxQueued?: number } = {}) {
  const system = new FakeSystem();
  const kitchen = createTestPlayer({ system, roomName: 'Kitchen', uuid: 'RINCON_K' });
  const office = createTestPlayer({ system, roomName: 'Office', uuid: 'RINCON_O' });
  await kitchen.player.setAVTransport('x-rincon-queue:RINCON_K#0', '');
  system.addStandalone(kitchen.player);
  system.addStandalone(office.player);
  const order: string[] = [];
  system.applyPreset.mock.mockImplementation((preset: Preset) => {
    order.push(
      `${preset.state === 'STOPPED' && preset.uri === undefined ? 'play' : 'restore'}:${preset.players[0]?.roomName ?? ''}`,
    );
    return Promise.resolve();
  });
  const { logger, entries } = captureLogs();
  const transitions: AnnouncementTransition[] = [];
  const scheduler = new AnnouncementScheduler({
    system,
    logger,
    maxQueued: options.maxQueued ?? 10,
    topologyTimeoutMs: 1000,
    restoreVerifyMs: 500,
    resumeRewindMs: 1000,
  });
  scheduler.on('transition', (transition) => transitions.push(transition));
  const spec = (
    room: 'Kitchen' | 'Office',
    extra: Partial<AnnouncementSpec> = {},
  ): AnnouncementSpec => ({
    target: { kind: 'player', player: room === 'Kitchen' ? kitchen.player : office.player },
    prepare: () => Promise.resolve(CLIP),
    source: 'test',
    volume: 40,
    ...extra,
  });
  return { system, kitchen, office, scheduler, spec, order, transitions, entries };
}

/** Ticks mock timers until every promise has settled. */
async function settleAll(promises: Array<Promise<unknown>>, stepMs = 500, maxSteps = 120) {
  let pending = promises.length;
  for (const promise of promises) {
    promise.then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );
  }
  for (let step = 0; step < maxSteps && pending > 0; step += 1) {
    await flushPromises();
    mock.timers.tick(stepMs);
  }
  await flushPromises();
  assert.equal(pending, 0, 'announcements did not settle');
}

describe('AnnouncementScheduler', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  it('runs announcements one after another, in the order submitted', async () => {
    const { scheduler, spec, order, transitions } = await setup();

    const first = scheduler.submit(spec('Kitchen'));
    const second = scheduler.submit(spec('Office'));
    assert.notEqual(first.id, second.id);
    assert.equal(scheduler.queued, 1);
    assert.equal(scheduler.current, first.id);
    await settleAll([first.done, second.done]);

    assert.deepEqual(order, ['play:Kitchen', 'restore:Kitchen', 'play:Office', 'restore:Office']);
    assert.equal(scheduler.queued, 0);
    assert.equal(scheduler.current, undefined);
    assert.deepEqual(
      transitions.map((t) => `${t.id === first.id ? 'first' : 'second'}:${t.state}`),
      [
        'first:queued',
        'first:starting',
        'second:queued',
        'first:playing',
        'first:restoring',
        'first:done',
        'second:starting',
        'second:playing',
        'second:restoring',
        'second:done',
      ],
    );
    const result = await first.done;
    assert.equal(result.timings.queuedMs, 0);
    assert.ok(((await second.done).timings.queuedMs ?? 0) > 0, 'the second one waited');
  });

  it('carries on after a failed announcement and passes the failure to its caller', async () => {
    const { scheduler, spec, order } = await setup();
    const failing = scheduler.submit(
      spec('Kitchen', { prepare: () => Promise.reject(new Error('polly down')) }),
    );
    const next = scheduler.submit(spec('Office'));
    failing.done.catch(() => undefined);

    await settleAll([failing.done, next.done]);

    await assert.rejects(failing.done, /polly down/);
    assert.equal((await next.done).state, 'done');
    assert.deepEqual(order, ['play:Kitchen', 'restore:Kitchen', 'play:Office', 'restore:Office']);
  });

  it('skips a queued announcement that was cancelled', async () => {
    const { scheduler, spec, order } = await setup();
    const first = scheduler.submit(spec('Kitchen'));
    const cancelled = scheduler.submit(spec('Office'));
    const last = scheduler.submit(spec('Kitchen'));
    cancelled.cancel();
    assert.equal((await cancelled.done).state, 'cancelled');
    assert.equal(scheduler.queued, 1, 'a cancelled announcement leaves the queue at once');

    await settleAll([first.done, last.done]);

    assert.deepEqual(order, ['play:Kitchen', 'restore:Kitchen', 'play:Kitchen', 'restore:Kitchen']);
  });

  it('refuses more than maxQueued waiting announcements with 503 and Retry-After', async () => {
    const { scheduler, spec } = await setup({ maxQueued: 1 });
    const first = scheduler.submit(spec('Kitchen'));
    const second = scheduler.submit(spec('Office'));

    assert.throws(
      () => scheduler.submit(spec('Kitchen')),
      (error: unknown) =>
        error instanceof ServiceUnavailableError &&
        error.headers?.['Retry-After'] === '10' &&
        /too many announcements/i.test(error.message),
    );

    await settleAll([first.done, second.done]);
    const third = scheduler.submit(spec('Kitchen'));
    await settleAll([third.done]);
    assert.equal((await third.done).state, 'done', 'room again once the queue has moved on');
  });

  it('drains for shutdown: refuses new work, drops the queue, stops and restores the current one', async () => {
    const { scheduler, spec, order, kitchen } = await setup();
    const playing = scheduler.submit(spec('Kitchen'));
    const waiting = scheduler.submit(spec('Office'));
    await flushPromises();
    kitchen.soap.calls.length = 0;

    const drained = scheduler.drain(5000);
    assert.throws(() => scheduler.submit(spec('Office')), ServiceUnavailableError);
    await settleAll([drained, playing.done, waiting.done]);

    assert.equal((await waiting.done).state, 'cancelled');
    assert.equal((await playing.done).state, 'cancelled');
    assert.ok(kitchen.soap.calls.some((call) => call.action.endsWith('#Stop')));
    assert.deepEqual(order, ['play:Kitchen', 'restore:Kitchen']);
    assert.equal(scheduler.queued, 0);
  });

  it('drain gives up after its timeout when the current announcement will not finish', async () => {
    const { scheduler, spec, system } = await setup();
    system.applyPreset.mock.mockImplementation(() => new Promise<void>(() => {}));
    const stuck = scheduler.submit(spec('Kitchen'));
    await flushPromises();

    const drained = scheduler.drain(3000);
    let finished = false;
    void drained.then(() => {
      finished = true;
    });
    mock.timers.tick(2999);
    await flushPromises();
    assert.equal(finished, false);
    mock.timers.tick(1);
    await flushPromises();
    assert.equal(finished, true);
    assert.equal(scheduler.current, stuck.id, 'still stuck, but the process may exit now');
  });

  it('drain resolves at once when nothing is running', async () => {
    const { scheduler, spec } = await setup();
    await scheduler.drain(1000);
    assert.throws(
      () => scheduler.submit(spec('Kitchen')),
      (error: unknown) =>
        error instanceof ServiceUnavailableError && /shutting down/.test(error.message),
    );
  });

  it('logs each announcement with its id, source and request id', async () => {
    const { scheduler, spec, entries } = await setup();
    const handle = scheduler.submit(spec('Kitchen', { requestId: 'req-1' }));
    await settleAll([handle.done]);

    const done = entries().find((entry) => entry.msg === 'announcement done');
    assert.equal(done?.announcementId, handle.id);
    assert.equal(done?.source, 'test');
    assert.equal(done?.requestId, 'req-1');
  });

  describe('priority', () => {
    const LONG = { uri: CLIP.uri, durationMs: 20_000 };
    type Spec = Awaited<ReturnType<typeof setup>>['spec'];
    const briefing = (spec: Spec) =>
      spec('Kitchen', { source: 'briefing', prepare: () => Promise.resolve(LONG) });
    const doorbell = (spec: Spec) => spec('Office', { source: 'doorbell', priority: 'urgent' });

    it('an urgent announcement interrupts a playing normal one, which resumes when it is done', async () => {
      const { scheduler, spec, order, transitions, kitchen } = await setup();
      const normal = scheduler.submit(briefing(spec));
      await flushPromises();
      mock.timers.tick(3000);
      kitchen.soap.calls.length = 0;

      const urgent = scheduler.submit(doorbell(spec));
      await flushPromises();
      assert.equal(scheduler.current, urgent.id, 'the doorbell has the speakers');
      assert.equal(scheduler.queued, 1, 'the briefing waits');
      await settleAll([normal.done, urgent.done]);

      assert.deepEqual(order, ['play:Kitchen', 'play:Office', 'restore:Office', 'restore:Kitchen']);
      const actions = kitchen.soap.calls.map((c) => c.action.slice(c.action.indexOf('#') + 1));
      assert.deepEqual(actions, ['Pause', 'GetPositionInfo', 'Seek', 'Play']);
      assert.deepEqual(
        transitions.filter((t) => t.id === normal.id).map((t) => t.state),
        ['queued', 'starting', 'playing', 'interrupted', 'playing', 'restoring', 'done'],
      );
      assert.equal((await normal.done).interruptions, 1);
      assert.equal((await urgent.done).priority, 'urgent');
      const queued = transitions.find((t) => t.id === urgent.id);
      assert.equal(queued?.previousState, undefined);
      assert.equal(queued?.target, 'room:Office');
    });

    it('an urgent one that arrives while the normal one is still starting waits for it to play', async () => {
      const { scheduler, spec, order, system } = await setup();
      const gate = deferred();
      system.applyPreset.mock.mockImplementation(async (preset: Preset) => {
        if (preset.players[0]?.roomName === 'Kitchen' && preset.uri === undefined) {
          await gate.promise;
        }
        order.push(
          `${preset.uri === undefined && preset.state === 'STOPPED' ? 'play' : 'restore'}:${preset.players[0]?.roomName ?? ''}`,
        );
      });
      const normal = scheduler.submit(briefing(spec));
      const urgent = scheduler.submit(doorbell(spec));
      await flushPromises();
      assert.equal(scheduler.current, normal.id, 'not interrupted while starting');

      gate.release();
      await settleAll([normal.done, urgent.done]);
      assert.deepEqual(order, ['play:Kitchen', 'play:Office', 'restore:Office', 'restore:Kitchen']);
      assert.equal((await normal.done).interruptions, 1);
    });

    it('urgent never interrupts urgent, and a second urgent goes ahead of the resume', async () => {
      const { scheduler, spec, order } = await setup();
      const normal = scheduler.submit(briefing(spec));
      await flushPromises();
      mock.timers.tick(1000);
      const first = scheduler.submit(doorbell(spec));
      await flushPromises();
      await flushPromises();
      assert.equal(scheduler.current, first.id);
      const second = scheduler.submit(doorbell(spec));
      await flushPromises();
      assert.equal(scheduler.current, first.id, 'the first doorbell keeps playing');

      await settleAll([normal.done, first.done, second.done]);
      assert.deepEqual(order, [
        'play:Kitchen',
        'play:Office',
        'restore:Office',
        'play:Office',
        'restore:Office',
        'restore:Kitchen',
      ]);
      assert.equal((await normal.done).interruptions, 1, 'parked once, resumed after both');
    });

    it('find returns waiting, playing and interrupted announcements, and drain restores them all', async () => {
      const { scheduler, spec, order } = await setup();
      const normal = scheduler.submit(briefing(spec));
      const waiting = scheduler.submit(spec('Kitchen'));
      await flushPromises();
      mock.timers.tick(1000);
      const urgent = scheduler.submit(doorbell(spec));
      await flushPromises();
      await flushPromises();
      assert.equal(scheduler.find(normal.id)?.id, normal.id, 'interrupted');
      assert.equal(scheduler.find(urgent.id)?.id, urgent.id, 'playing');
      assert.equal(scheduler.find(waiting.id)?.id, waiting.id, 'queued');
      assert.equal(scheduler.find('nope'), undefined);
      assert.equal(scheduler.queued, 2);

      const drained = scheduler.drain(10_000);
      await settleAll([drained, normal.done, urgent.done, waiting.done]);
      assert.equal((await waiting.done).state, 'cancelled');
      assert.equal((await urgent.done).state, 'cancelled');
      assert.equal((await normal.done).state, 'cancelled');
      assert.deepEqual(order, ['play:Kitchen', 'play:Office', 'restore:Office', 'restore:Kitchen']);
      assert.equal(scheduler.find(normal.id), undefined);
    });
  });
});
