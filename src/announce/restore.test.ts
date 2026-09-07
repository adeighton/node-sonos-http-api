import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { RequestTimeoutError } from '../discovery/errors.ts';
import type { Player, Zone } from '../discovery/player.ts';
import type { Preset } from '../discovery/types.ts';
import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { deferred } from '../testing/fake-player.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import type { TestPlayer } from '../testing/test-player.ts';
import { planAnnouncement } from './plan.ts';
import { captureRestorePlan, hasQueuePosition, isRestorableUri, runRestore } from './restore.ts';

async function playing(
  system: FakeSystem,
  room: string,
  uuid: string,
  volume: number,
  uri: string,
  state = 'PAUSED_PLAYBACK',
): Promise<TestPlayer> {
  const created = createTestPlayer({ system, roomName: room, uuid });
  const { player } = created;
  await player.handleLastChange({ volume: [{ channel: 'Master', val: String(volume) }] });
  await player.handleLastChange({
    transportstate: { val: state },
    currenttrack: { val: '4' },
    currentplaymode: { val: 'REPEAT_ALL' },
    avtransporturi: { val: 'x-rincon:SKIP' }, // grouped shape: no position lookup in tests
  });
  await player.setAVTransport(uri, '<m/>');
  return created;
}

function group(system: FakeSystem, coordinator: Player, ...members: Player[]): Zone {
  const zone = system.addStandalone(coordinator);
  for (const member of members) {
    member.coordinator = coordinator;
    zone.members.push(member);
    system.players.push(member);
  }
  return zone;
}

/** Runs `promise` to completion while ticking mock timers. */
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
    throw new Error('did not settle');
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

describe('uri classification', () => {
  it('recognizes app sessions and queue positions', () => {
    assert.equal(isRestorableUri(''), false);
    assert.equal(isRestorableUri('x-sonos-vli:RINCON_1:2,airplay:abc'), false);
    assert.equal(isRestorableUri('x-rincon-queue:RINCON_1#0'), true);
    assert.equal(isRestorableUri('x-sonosapi-stream:s1'), true);
    assert.equal(hasQueuePosition('x-rincon-queue:RINCON_1#0', 3), true);
    assert.equal(hasQueuePosition('x-rincon-queue:RINCON_1#0', 0), false, 'empty queue');
    assert.equal(hasQueuePosition('x-rincon:RINCON_1', 1), false, 'group link');
    assert.equal(hasQueuePosition('x-sonosapi-stream:s1', 1), false, 'stream');
    assert.equal(hasQueuePosition('http://192.168.2.10:5005/tts/x.mp3', 1), false, 'a clip url');
  });
});

describe('captureRestorePlan', () => {
  it('backs up a standalone target with its playback position as a zone step', async () => {
    const system = new FakeSystem();
    const kitchen = await playing(system, 'Kitchen', 'RINCON_K', 30, 'x-rincon-queue:RINCON_K#0');
    system.addStandalone(kitchen.player);
    const plan = planAnnouncement(system, { target: { kind: 'player', player: kitchen.player } });

    const { steps } = captureRestorePlan(system, plan);

    assert.deepEqual(steps, [
      {
        kind: 'zone',
        room: 'Kitchen',
        preset: {
          players: [{ roomName: 'Kitchen', volume: 30 }],
          state: 'PAUSED_PLAYBACK',
          uri: 'x-rincon-queue:RINCON_K#0',
          metadata: '<m/>',
          playMode: { repeat: 'all' },
          trackNo: 4,
          elapsedTime: 0,
        },
      },
    ]);
  });

  it('falls back to the stopped queue for an empty transport or an AirPlay session', async () => {
    const system = new FakeSystem();
    const idle = createTestPlayer({ system, roomName: 'Family Room', uuid: 'RINCON_F' }).player;
    await idle.handleLastChange({
      transportstate: { val: 'PLAYING' },
      currenttrack: { val: '1' },
      currentplaymode: { val: 'REPEAT_ALL' },
    });
    system.addStandalone(idle);
    const airplay = await playing(
      system,
      'Den',
      'RINCON_D',
      20,
      'x-sonos-vli:RINCON_D:2,airplay:x',
    );
    system.addStandalone(airplay.player);

    const { steps } = captureRestorePlan(
      system,
      planAnnouncement(system, { target: { kind: 'all' } }),
    );

    assert.deepEqual(
      steps.map((step) => (step.kind === 'zone' ? step.preset : step)),
      [
        {
          players: [{ roomName: 'Den', volume: 20 }],
          state: 'STOPPED',
          uri: 'x-rincon-queue:RINCON_D#0',
          metadata: '',
          playMode: { repeat: 'all' },
        },
        {
          players: [{ roomName: 'Family Room', volume: 0 }],
          state: 'STOPPED',
          uri: 'x-rincon-queue:RINCON_F#0',
          metadata: '',
          playMode: { repeat: 'all' },
        },
      ],
      'the announcement coordinator (Family Room) is restored last',
    );
  });

  it('omits the position for radio, an empty queue and a player still shown as rejoining', async () => {
    const system = new FakeSystem();
    const radio = await playing(system, 'Den', 'RINCON_D', 10, 'x-sonosapi-stream:s1?sid=254');
    system.addStandalone(radio.player);
    const empty = createTestPlayer({ system, roomName: 'Kitchen', uuid: 'RINCON_K' }).player;
    await empty.handleLastChange({
      transportstate: { val: 'STOPPED' },
      currenttrack: { val: '0' },
      avtransporturi: { val: 'x-rincon-queue:RINCON_K#0' },
    });
    system.addStandalone(empty);
    const rejoining = await playing(system, 'Hall', 'RINCON_H', 30, 'x-rincon:RINCON_F');
    system.addStandalone(rejoining.player);

    const { steps } = captureRestorePlan(
      system,
      planAnnouncement(system, { target: { kind: 'all' } }),
    );

    for (const step of steps) {
      assert.equal(step.kind, 'zone');
      assert.equal(step.kind === 'zone' && 'trackNo' in step.preset, false, step.room);
    }
  });

  it('classifies zones: whole zones for target coordinators, rejoins for members, resumes for the paused', async () => {
    const system = new FakeSystem();
    // Zone 1: A coordinates A+B, both targets → whole zone restored.
    const a = await playing(system, 'A', 'RINCON_A', 10, 'x-rincon-queue:RINCON_A#0');
    const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' });
    group(system, a.player, b.player);
    // Zone 2: C coordinates C+D; only D is a target → D rejoins C's group afterwards.
    const c = await playing(system, 'C', 'RINCON_C', 20, 'x-sonosapi-stream:s2', 'PLAYING');
    const d = createTestPlayer({ system, roomName: 'D', uuid: 'RINCON_D' });
    await d.player.handleLastChange({ volume: [{ channel: 'Master', val: '7' }] });
    group(system, c.player, d.player);
    // Zone 3: E plays alone and is not a target → paused by pauseOthers, resumed afterwards.
    const e = await playing(system, 'E', 'RINCON_E', 30, 'x-rincon-queue:RINCON_E#0', 'PLAYING');
    system.addStandalone(e.player);
    // Zone 4: F is stopped and not a target → untouched.
    const f = await playing(system, 'F', 'RINCON_F', 30, 'x-rincon-queue:RINCON_F#0', 'STOPPED');
    system.addStandalone(f.player);
    const preset: Preset = {
      players: [{ roomName: 'A', volume: 50 }, { roomName: 'B', volume: 50 }, { roomName: 'D' }],
      pauseOthers: true,
    };

    const { steps } = captureRestorePlan(
      system,
      planAnnouncement(system, { target: { kind: 'preset', preset } }),
    );

    assert.deepEqual(
      steps.map((step) => ({ kind: step.kind, room: step.room })),
      [
        { kind: 'rejoin', room: 'D' },
        { kind: 'resume', room: 'E' },
        { kind: 'zone', room: 'A' },
      ],
      'the announcement coordinator (A) comes last',
    );
    const zone = steps[2];
    assert.ok(zone?.kind === 'zone');
    assert.deepEqual(zone.preset.players, [
      { roomName: 'A', volume: 10 },
      { roomName: 'B', volume: 0 },
    ]);
    const rejoin = steps[0];
    assert.ok(rejoin?.kind === 'rejoin');
    assert.deepEqual(rejoin, { kind: 'rejoin', room: 'D', volume: 7, groupOf: ['RINCON_C'] });

    // Zone 3 is only resumed when the announcement pauses others.
    const { steps: quiet } = captureRestorePlan(
      system,
      planAnnouncement(system, {
        target: { kind: 'preset', preset: { ...preset, pauseOthers: false } },
      }),
    );
    assert.deepEqual(
      quiet.map((step) => step.kind),
      ['rejoin', 'zone'],
    );
  });

  it('lets a lone target coordinator rejoin the group it left, whoever leads it by then', async () => {
    const system = new FakeSystem();
    const a = await playing(system, 'A', 'RINCON_A', 10, 'x-rincon-queue:RINCON_A#0');
    const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' });
    const c = createTestPlayer({ system, roomName: 'C', uuid: 'RINCON_C' });
    group(system, a.player, b.player, c.player);

    const { steps } = captureRestorePlan(
      system,
      planAnnouncement(system, { target: { kind: 'player', player: a.player } }),
    );

    assert.deepEqual(steps, [
      { kind: 'rejoin', room: 'A', volume: 10, groupOf: ['RINCON_B', 'RINCON_C'] },
    ]);
  });

  it('puts whole zones largest first and every other step before the coordinator', async () => {
    const system = new FakeSystem();
    const a = await playing(system, 'A', 'RINCON_A', 10, 'x-rincon-queue:RINCON_A#0');
    system.addStandalone(a.player);
    const b = await playing(system, 'B', 'RINCON_B', 10, 'x-rincon-queue:RINCON_B#0');
    const c = createTestPlayer({ system, roomName: 'C', uuid: 'RINCON_C' });
    group(system, b.player, c.player);

    const { steps } = captureRestorePlan(
      system,
      planAnnouncement(system, { target: { kind: 'all' } }),
    );

    assert.deepEqual(
      steps.map((step) => step.room),
      ['A', 'B'],
      'the announcement coordinator (B, the biggest group) comes last',
    );
  });
});

describe('runRestore', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  async function house() {
    const system = new FakeSystem();
    const a = await playing(system, 'A', 'RINCON_A', 10, 'x-rincon-queue:RINCON_A#0');
    const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' });
    group(system, a.player, b.player);
    const c = await playing(system, 'C', 'RINCON_C', 20, 'x-sonosapi-stream:s2', 'PLAYING');
    const d = createTestPlayer({ system, roomName: 'D', uuid: 'RINCON_D' });
    group(system, c.player, d.player);
    const e = await playing(system, 'E', 'RINCON_E', 30, 'x-rincon-queue:RINCON_E#0', 'PLAYING');
    system.addStandalone(e.player);
    const preset: Preset = {
      players: [{ roomName: 'A', volume: 50 }, { roomName: 'B', volume: 50 }, { roomName: 'D' }],
      pauseOthers: true,
    };
    const plan = planAnnouncement(system, { target: { kind: 'preset', preset } });
    const captured = captureRestorePlan(system, plan);
    const { logger, messages } = captureLogs();
    // What the announcement did: D now follows A, and E was paused.
    const before = system.zones.map((zone) => ({ ...zone, members: [...zone.members] }));
    system.zones = [
      {
        uuid: 'RINCON_A',
        id: 'RINCON_A:2',
        coordinator: a.player,
        members: [a.player, b.player, d.player],
      },
      { uuid: 'RINCON_C', id: 'RINCON_C:2', coordinator: c.player, members: [c.player] },
      { uuid: 'RINCON_E', id: 'RINCON_E:1', coordinator: e.player, members: [e.player] },
    ];
    d.player.coordinator = a.player;
    /** The players are back where they were: swap the zones and announce it. */
    const settleTopology = (): void => {
      system.zones = before;
      d.player.coordinator = c.player;
      system.emit('topology-change', system.zones);
    };
    return { system, a, b, c, d, e, plan, captured, logger, messages, settleTopology };
  }

  it('runs every step, the coordinator last, and reports ok when the topology settles', async () => {
    const { system, d, e, captured, logger, settleTopology } = await house();
    const order: string[] = [];
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      order.push(`zone:${preset.players.map((p) => p.roomName).join('+')}`);
      return Promise.resolve();
    });
    d.soap.calls.length = 0;
    e.soap.calls.length = 0;
    const rejoinGate = deferred();
    const setAVTransport = d.player.setAVTransport.bind(d.player);
    d.player.setAVTransport = async (uri, metadata) => {
      await rejoinGate.promise;
      await setAVTransport(uri, metadata);
    };

    const pending = runRestore(system, captured, { logger, verifyTimeoutMs: 3000 });
    await flushPromises();
    assert.equal(e.soap.calls.filter((call) => call.action.endsWith('#Play')).length, 1);
    assert.deepEqual(order, [], 'the coordinator waits for the other steps');
    rejoinGate.release();
    await flushPromises();
    assert.equal(
      d.soap.calls.filter((call) => call.action.endsWith('#SetAVTransportURI')).length,
      1,
    );
    assert.deepEqual(order, ['zone:A+B']);

    // Not settled yet: D is still shown under A.
    mock.timers.tick(1000);
    await flushPromises();
    settleTopology();
    const result = await settle(pending);

    assert.deepEqual(result, { restore: 'ok', warnings: [] });
    const rejoin = d.soap.calls.find((call) => call.action.endsWith('#SetAVTransportURI'));
    assert.equal(rejoin?.values?.uri, 'x-rincon:RINCON_C');
    assert.equal(
      d.soap.calls.filter((call) => call.action.endsWith('#SetVolume')).length,
      1,
      'a rejoining member gets its volume back',
    );
  });

  it('retries a step once, then reports it as a warning and the restore as partial', async () => {
    const { system, d, captured, logger, messages } = await house();
    let zoneAttempts = 0;
    system.applyPreset.mock.mockImplementation(() => {
      zoneAttempts += 1;
      return zoneAttempts === 1
        ? Promise.reject(new RequestTimeoutError('http://a', 10_000))
        : Promise.resolve();
    });
    d.soap.queueFailure(new Error('busy'));
    d.soap.queueFailure(new Error('still busy'));

    const result = await settle(runRestore(system, captured, { logger, verifyTimeoutMs: 1000 }));

    assert.equal(zoneAttempts, 2, 'the zone restore succeeded on its retry');
    assert.equal(result.restore, 'partial');
    assert.deepEqual(result.warnings, [
      'D: rejoin failed: still busy',
      'D: still grouped elsewhere after 1000 ms',
      'A: group not re-formed after 1000 ms',
    ]);
    assert.ok(messages().includes('restore step failed'));
  });

  it('warns when the topology never settles', async () => {
    const { system, captured, logger } = await house();

    const result = await settle(runRestore(system, captured, { logger, verifyTimeoutMs: 2000 }));

    assert.equal(result.restore, 'partial');
    assert.deepEqual(result.warnings, [
      'D: still grouped elsewhere after 2000 ms',
      'A: group not re-formed after 2000 ms',
    ]);
  });

  it('rejoins the survivors through whoever coordinates them now', async () => {
    const system = new FakeSystem();
    const a = await playing(system, 'A', 'RINCON_A', 10, 'x-rincon-queue:RINCON_A#0');
    const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' });
    group(system, a.player, b.player);
    const captured = captureRestorePlan(
      system,
      planAnnouncement(system, { target: { kind: 'player', player: a.player } }),
    );
    // A left; B now leads on its own. A must join B.
    system.zones = [
      { uuid: 'RINCON_B', id: 'RINCON_B:9', coordinator: b.player, members: [b.player] },
      { uuid: 'RINCON_A', id: 'RINCON_A:9', coordinator: a.player, members: [a.player] },
    ];
    b.player.coordinator = b.player;
    a.soap.calls.length = 0;

    const pending = runRestore(system, captured, { verifyTimeoutMs: 1000 });
    await flushPromises();
    a.player.coordinator = b.player;
    system.emit('topology-change', [
      { uuid: 'RINCON_B', id: 'RINCON_B:9', coordinator: b.player, members: [b.player, a.player] },
    ]);
    const result = await settle(pending);

    assert.deepEqual(result, { restore: 'ok', warnings: [] });
    const rejoin = a.soap.calls.find((call) => call.action.endsWith('#SetAVTransportURI'));
    assert.equal(rejoin?.values?.uri, 'x-rincon:RINCON_B');

    // When the group vanished there is nothing to rejoin: the player is left standalone.
    system.zones = [system.zones[1] as Zone];
    a.player.coordinator = a.player;
    a.soap.calls.length = 0;
    const alone = await settle(runRestore(system, captured, { verifyTimeoutMs: 1000 }));
    assert.deepEqual(alone, { restore: 'ok', warnings: [] });
    assert.equal(
      a.soap.calls.some((call) => call.action.endsWith('#SetAVTransportURI')),
      false,
    );
  });
});
