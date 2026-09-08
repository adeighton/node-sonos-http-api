import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Preset } from '../discovery/types.ts';
import { RequestTimeoutError, SoapFaultError } from '../discovery/errors.ts';
import { BadRequestError } from '../http/errors.ts';
import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { fixturePath } from '../testing/fixtures.ts';
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
        resumeRewindMs: 1000,
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
    assert.equal(result.priority, 'normal');
    assert.equal(result.interruptions, 0);
    assert.deepEqual(result.rooms, ['Kitchen']);
    assert.equal(transitions.at(-1)?.result, result, 'the final transition carries the result');
    assert.deepEqual(result.clip, CLIP);
    assert.equal(result.restore, 'ok');
    assert.deepEqual(
      result.warnings,
      ['the clip was not heard playing; the rooms may have been silent'],
      'the player never reported playing, so done does not claim it was heard',
    );
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
    assert.deepEqual(result.warnings, [], 'the clip was heard from start to finish');
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

  it('never touches the speakers when the clip fails before the group is formed', async () => {
    const { system, kitchen, runner, states } = await setup();
    kitchen.soap.calls.length = 0;

    const pending = runner({
      target: { kind: 'player', player: kitchen.player },
      prepare: () => Promise.reject(new BadRequestError("Unknown Polly voice 'Gandalf'")),
    }).start();

    await assert.rejects(settle(pending), /Gandalf/);
    assert.equal(system.appliedPresets.length, 0, 'nothing was grouped');
    assert.equal(kitchen.soap.calls.length, 0, 'and nothing was asked of the player');
    assert.deepEqual(states, ['starting', 'failed'], 'nothing to restore either');
  });

  it('retries the transport change and the play while the player is still switching', async () => {
    const { kitchen, runner, messages } = await setup();
    kitchen.soap.calls.length = 0;
    // In call order: the transport change times out, its retry lands, Play is refused because the
    // player is still switching, its retry lands.
    kitchen.soap.queueFailure(new RequestTimeoutError('http://player/AVTransport', 10));
    kitchen.soap.queueResponse(Readable.from([]));
    kitchen.soap.queueFailure(
      new SoapFaultError('http://player/AVTransport', 'Play', 701, 'transition not available', ''),
    );

    const result = await settle(
      runner({ target: { kind: 'player', player: kitchen.player } }).start(),
    );

    assert.deepEqual(soapActions(kitchen.soap.calls), [
      'SetAVTransportURI',
      'SetAVTransportURI',
      'Play',
      'Play',
    ]);
    assert.equal(result.state, 'done');
    assert.equal(messages().filter((m) => m === 'command failed, retrying').length, 2);
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
    const { system, runner, states, transitions } = await setup();
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
    assert.match(transitions.at(-1)?.error ?? '', /Attic/);
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

  describe('interrupt and resume', () => {
    const LONG = { uri: CLIP.uri, durationMs: 200_000 };

    it('pauses, remembers the position and carries on a second earlier when resumed', async () => {
      const { system, kitchen, runner, states } = await setup();
      const job = runner({
        target: { kind: 'player', player: kitchen.player },
        prepare: () => Promise.resolve(LONG),
      });
      const pending = job.start();
      await flushPromises();
      assert.equal(job.state, 'playing');
      kitchen.soap.calls.length = 0;
      mock.timers.tick(5000);
      kitchen.soap.queueResponse(Readable.from([])); // Pause
      kitchen.soap.queueResponse(createReadStream(fixturePath('getpositioninfo.xml'))); // 2:22

      const parked = job.interrupt();
      await flushPromises();
      assert.equal(await parked, 'interrupted');
      assert.deepEqual(soapActions(kitchen.soap.calls), ['Pause', 'GetPositionInfo']);
      assert.equal(kitchen.player.listenerCount('playback-state'), 0, 'the waiter is gone');
      assert.equal(system.appliedPresets.length, 1, 'nothing restored while parked');

      kitchen.soap.calls.length = 0;
      job.resume();
      await flushPromises();
      assert.deepEqual(soapActions(kitchen.soap.calls), ['Seek', 'Play']);
      assert.deepEqual(kitchen.soap.calls[0]?.values, { unit: 'REL_TIME', value: '00:02:21' });
      assert.equal(job.state, 'playing');

      kitchen.player.emit('playback-state', 'PLAYING');
      kitchen.player.emit('playback-state', 'STOPPED');
      const result = await settle(pending);
      assert.equal(result.state, 'done');
      assert.equal(result.interruptions, 1);
      assert.deepEqual(states, [
        'starting',
        'playing',
        'interrupted',
        'playing',
        'restoring',
        'done',
      ]);
      assert.equal(result.timings.playMs, 5000, 'time spent playing, not parked');
      assert.equal(system.appliedPresets.length, 2);
    });

    it('uses the clock when the player reports no position, and does not resume a finished clip', async () => {
      const { kitchen, runner, states } = await setup();
      const job = runner({
        target: { kind: 'player', player: kitchen.player },
        prepare: () => Promise.resolve({ uri: CLIP.uri, durationMs: 10_000 }),
      });
      const pending = job.start();
      await flushPromises();
      mock.timers.tick(9500);
      kitchen.soap.calls.length = 0;

      const parked = job.interrupt();
      const result = await settle(pending);

      assert.equal(await parked, 'ended');
      assert.deepEqual(soapActions(kitchen.soap.calls), ['Pause', 'GetPositionInfo']);
      assert.equal(result.state, 'done');
      assert.equal(result.interruptions, 0);
      assert.equal(states.includes('interrupted'), false);
    });

    it('re-forms the group and sets the clip again when the urgent one left things changed', async () => {
      const { system, kitchen, office, runner } = await setup();
      const preset = { players: [{ roomName: 'Kitchen' }, { roomName: 'Office' }] };
      const grouped = [
        {
          uuid: 'RINCON_K',
          id: 'x',
          coordinator: kitchen.player,
          members: [kitchen.player, office.player],
        },
      ];
      const apart = system.zones;
      system.zones = grouped;
      const job = runner({
        target: { kind: 'preset', preset },
        prepare: () => Promise.resolve(LONG),
      });
      const pending = job.start();
      await flushPromises();
      assert.equal(job.state, 'playing');
      mock.timers.tick(2000);
      await job.interrupt();

      // The doorbell moved things around: the rooms stand alone and Kitchen plays something else.
      system.zones = apart;
      await kitchen.player.setAVTransport('x-rincon-queue:RINCON_K#0');
      kitchen.soap.calls.length = 0;
      job.resume();
      await flushPromises();
      assert.equal(system.appliedPresets.length, 2, 'the group preset was applied again');
      assert.equal(soapActions(kitchen.soap.calls).includes('Play'), false, 'waiting to regroup');
      system.zones = grouped;
      system.emit('topology-change', grouped);
      await flushPromises();
      assert.deepEqual(soapActions(kitchen.soap.calls), ['SetAVTransportURI', 'Seek', 'Play']);

      job.cancel();
      const result = await settle(pending);
      assert.equal(result.state, 'cancelled');
      assert.equal(result.interruptions, 1);
    });

    it('a cancel while interrupted takes effect on resume, so the urgent one is not disturbed', async () => {
      const { system, kitchen, runner, states } = await setup();
      const job = runner({
        target: { kind: 'player', player: kitchen.player },
        prepare: () => Promise.resolve(LONG),
      });
      const pending = job.start();
      await flushPromises();
      mock.timers.tick(1000);
      await job.interrupt();
      assert.equal(job.state, 'interrupted');

      job.cancel();
      await flushPromises();
      assert.equal(job.state, 'interrupted', 'still parked');
      assert.equal(system.appliedPresets.length, 1, 'no restore yet');

      job.resume();
      const result = await settle(pending);
      assert.equal(result.state, 'cancelled');
      assert.equal(system.appliedPresets.length, 2);
      assert.deepEqual(states, ['starting', 'playing', 'interrupted', 'restoring', 'cancelled']);
    });

    it('interrupt is a no-op unless the announcement is playing', async () => {
      const { kitchen, runner } = await setup();
      const job = runner({ target: { kind: 'player', player: kitchen.player } });
      assert.equal(await job.interrupt(), 'ended');
      job.cancel();
      assert.equal((await job.done).state, 'cancelled');
    });
  });
});
