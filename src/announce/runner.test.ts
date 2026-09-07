import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Preset } from '../discovery/types.ts';
import { BadRequestError } from '../http/errors.ts';
import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { AnnouncementRunner } from './runner.ts';
import type { AnnouncementSpec, AnnouncementState, AnnouncementTransition } from './types.ts';

const CLIP = { uri: 'http://127.0.0.1:5005/tts/hi.mp3', durationMs: 2000 };

async function setup() {
  const system = new FakeSystem();
  const kitchen = createTestPlayer({ system, roomName: 'Kitchen', uuid: 'RINCON_K' });
  const office = createTestPlayer({ system, roomName: 'Office', uuid: 'RINCON_O' });
  const den = createTestPlayer({ system, roomName: 'Den', uuid: 'RINCON_D' });
  await kitchen.player.handleLastChange({ volume: [{ channel: 'Master', val: '30' }] });
  await office.player.handleLastChange({ volume: [{ channel: 'Master', val: '15' }] });
  await kitchen.player.setAVTransport('x-rincon-queue:RINCON_K#0', '');
  system.addStandalone(kitchen.player);
  system.addStandalone(office.player);
  system.addStandalone(den.player);
  const { logger, messages } = captureLogs();
  const states: AnnouncementState[] = [];
  const transitions: AnnouncementTransition[] = [];
  const runner = (spec: Partial<AnnouncementSpec> & Pick<AnnouncementSpec, 'target'>) =>
    new AnnouncementRunner(
      'a1',
      { prepare: () => Promise.resolve(CLIP), source: 'test', volume: 40, ...spec },
      {
        system,
        logger,
        topologyTimeoutMs: 1000,
        restoreVerifyMs: 500,
        onTransition: (transition) => {
          states.push(transition.state);
          transitions.push(transition);
        },
      },
    );
  return { system, kitchen, office, den, runner, messages, states, transitions };
}

/** Runs `promise` to completion while ticking mock timers; rethrows its rejection at the end. */
async function settle<T>(promise: Promise<T>, stepMs = 500, maxSteps = 40): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  promise.then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  for (let step = 0; step < maxSteps && outcome === undefined; step += 1) {
    await flushPromises();
    mock.timers.tick(stepMs);
  }
  await flushPromises();
  if (outcome === undefined) {
    throw new Error('announcement did not settle');
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

const soapActions = (calls: Array<{ action: string }>) =>
  calls.map((call) => call.action.slice(call.action.indexOf('#') + 1));

describe('AnnouncementRunner', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('groups, sets the clip, plays, waits for the end and restores, reporting each stage', async () => {
    const { system, kitchen, runner, states, transitions } = await setup();
    kitchen.soap.calls.length = 0;

    const result = await settle(
      runner({ target: { kind: 'player', player: kitchen.player } }).start(),
    );

    const [group, restore] = system.appliedPresets;
    assert.deepEqual(group, {
      players: [{ roomName: 'Kitchen', volume: 40 }],
      playMode: { repeat: 'none' },
      pauseOthers: false,
      state: 'STOPPED',
    });
    assert.deepEqual(soapActions(kitchen.soap.calls), ['SetAVTransportURI', 'Play']);
    assert.equal(kitchen.soap.calls[0]?.values?.uri, CLIP.uri);
    assert.equal(restore?.players[0]?.volume, 30);
    assert.equal(restore?.uri, 'x-rincon-queue:RINCON_K#0');
    assert.equal(restore?.state, 'STOPPED');
    assert.equal(system.appliedPresets.length, 2);

    assert.deepEqual(states, ['starting', 'playing', 'restoring', 'done']);
    assert.deepEqual(
      transitions.map((t) => [t.id, t.previousState, t.source]),
      [
        ['a1', 'queued', 'test'],
        ['a1', 'starting', 'test'],
        ['a1', 'playing', 'test'],
        ['a1', 'restoring', 'test'],
      ],
    );
    assert.equal(result.id, 'a1');
    assert.equal(result.state, 'done');
    assert.deepEqual(result.rooms, ['Kitchen']);
    assert.deepEqual(result.clip, CLIP);
    assert.equal(result.restore, 'ok');
    assert.deepEqual(result.warnings, []);
    const { timings } = result;
    assert.equal(timings.queuedMs, 0);
    assert.equal(timings.playMs, 4000, 'no STOPPED arrived: the clip length plus the margin');
    for (const key of ['prepareMs', 'groupMs', 'topologyMs', 'restoreMs', 'totalMs'] as const) {
      assert.equal(typeof timings[key], 'number', key);
    }
    assert.equal(timings.totalMs, (transitions.at(-1)?.at ?? 0) - (transitions[0]?.at ?? 0));
  });

  it('restores as soon as the player reports the clip has stopped', async () => {
    const { system, kitchen, runner } = await setup();
    const pending = runner({ target: { kind: 'player', player: kitchen.player } }).start();
    await flushPromises();
    assert.equal(system.appliedPresets.length, 1);

    kitchen.player.emit('playback-state', 'PLAYING');
    kitchen.player.emit('playback-state', 'STOPPED');
    const result = await settle(pending);

    assert.equal(system.appliedPresets.length, 2);
    assert.equal(result.timings.playMs, 0);
    assert.equal(kitchen.player.listenerCount('playback-state'), 0, 'listeners are removed');
  });

  it('plays on every room through the biggest group once they have regrouped', async () => {
    const { system, kitchen, office, den, runner } = await setup();
    system.zones[0]?.members.push(office.player);
    office.player.coordinator = kitchen.player;
    system.zones.splice(1, 1);
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      system.appliedPresets.push(preset);
      if (preset.state === 'STOPPED' && preset.players.length === 3) {
        // Pretend the players regrouped a little later.
        setTimeout(() => {
          system.emit('topology-change', [
            {
              uuid: 'RINCON_K',
              id: 'x',
              coordinator: kitchen.player,
              members: [kitchen.player, office.player, den.player],
            },
          ]);
        }, 100);
      }
      return Promise.resolve();
    });
    kitchen.soap.calls.length = 0;

    const result = await settle(runner({ target: { kind: 'all' } }).start(), 100, 100);

    const [group] = system.appliedPresets;
    assert.deepEqual(group?.players, [
      { roomName: 'Kitchen', volume: 40 },
      { roomName: 'Office', volume: 40 },
      { roomName: 'Den', volume: 40 },
    ]);
    assert.equal(group?.pauseOthers, true);
    assert.deepEqual(soapActions(kitchen.soap.calls), ['SetAVTransportURI', 'Play']);
    assert.deepEqual(result.rooms, ['Kitchen', 'Office', 'Den']);
    assert.equal(result.timings.topologyMs, 100);
  });

  it('retries the grouping once and gives up waiting for a topology that never comes', async () => {
    const { system, kitchen, runner, messages } = await setup();
    let attempts = 0;
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      system.appliedPresets.push(preset);
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('first try fails')) : Promise.resolve();
    });
    const preset: Preset = {
      players: [
        { roomName: 'kitchen', volume: 60 },
        { roomName: 'Office', volume: 60 },
      ],
    };
    kitchen.soap.calls.length = 0;

    const result = await settle(
      runner({ target: { kind: 'preset', preset }, volume: undefined }).start(),
    );

    assert.deepEqual(system.appliedPresets[1]?.players, preset.players, 'retried');
    assert.ok(messages().includes('players did not regroup in time, playing anyway'));
    assert.equal(soapActions(kitchen.soap.calls).filter((a) => a === 'Play').length, 1);
    assert.equal(result.timings.topologyMs, 1000);
  });

  it('fails with the clip error but still restores when the clip cannot be prepared', async () => {
    const { system, kitchen, runner, states } = await setup();
    const pending = runner({
      target: { kind: 'player', player: kitchen.player },
      prepare: () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error('polly down')), 200)),
    }).start();
    await flushPromises();
    assert.equal(system.appliedPresets.length, 1, 'grouping does not wait for the clip');

    await assert.rejects(settle(pending), /polly down/);
    assert.equal(system.appliedPresets.length, 2, 'the room was restored');
    assert.deepEqual(states, ['starting', 'restoring', 'failed']);
  });

  it('rejects a bad target and restores nothing', async () => {
    const { system, runner, states } = await setup();
    await assert.rejects(
      settle(
        runner({
          target: { kind: 'preset', preset: { players: [{ roomName: 'Attic' }] } },
        }).start(),
      ),
      BadRequestError,
    );
    assert.equal(system.appliedPresets.length, 0);
    assert.deepEqual(states, ['starting', 'failed']);
  });

  it('reports a playback failure after restoring', async () => {
    const { system, kitchen, runner, states } = await setup();
    kitchen.soap.queueFailure(new Error('player offline'));

    await assert.rejects(
      settle(runner({ target: { kind: 'player', player: kitchen.player } }).start()),
      /player offline/,
    );

    assert.equal(system.appliedPresets.length, 2, 'the backup was still restored');
    assert.deepEqual(states, ['starting', 'restoring', 'failed']);
  });

  it('stops and restores when cancelled while playing', async () => {
    const { system, kitchen, runner, states } = await setup();
    const job = runner({ target: { kind: 'player', player: kitchen.player } });
    const pending = job.start();
    await flushPromises();
    kitchen.soap.calls.length = 0;
    mock.timers.tick(500);

    job.cancel();
    const result = await settle(pending);

    assert.deepEqual(soapActions(kitchen.soap.calls), ['Stop']);
    assert.equal(result.state, 'cancelled');
    assert.equal(system.appliedPresets.length, 2);
    assert.deepEqual(states, ['starting', 'playing', 'restoring', 'cancelled']);
    assert.equal(result.timings.playMs, 500);
    job.cancel(); // a second cancel is harmless
  });

  it('restores without ever playing when cancelled while the players regroup', async () => {
    const { system, kitchen, office, runner, states } = await setup();
    const job = runner({
      target: {
        kind: 'preset',
        preset: { players: [{ roomName: 'Kitchen' }, { roomName: 'Office' }] },
      },
    });
    const pending = job.start();
    await flushPromises();
    kitchen.soap.calls.length = 0;
    office.soap.calls.length = 0;

    job.cancel();
    const result = await settle(pending);

    assert.equal(result.state, 'cancelled');
    assert.equal(soapActions(kitchen.soap.calls).includes('Play'), false);
    assert.equal(system.appliedPresets.length, 3, 'the grouping, then one restore per room');
    assert.deepEqual(states, ['starting', 'restoring', 'cancelled']);
  });

  it('settles at once when cancelled before it started, and start() then does nothing', async () => {
    const { system, kitchen, runner, states } = await setup();
    const job = runner({ target: { kind: 'player', player: kitchen.player } });

    job.cancel();
    const result = await job.done;
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(result.rooms, []);
    assert.equal(result.clip, undefined);
    assert.deepEqual(states, ['cancelled']);

    assert.equal(await job.start(), result);
    assert.equal(system.appliedPresets.length, 0);
  });

  it('never leaves a rejected clip unhandled when nobody waits for it', async () => {
    const { runner } = await setup();
    const job = runner({
      target: { kind: 'all' },
      prepare: () => Promise.reject(new Error('polly down')),
    });
    job.cancel();
    await flushPromises();
    assert.equal((await job.done).state, 'cancelled');
  });
});
