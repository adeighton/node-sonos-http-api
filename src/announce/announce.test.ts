import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Preset } from '../discovery/types.ts';
import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { Announcer } from './announce.ts';

const CLIP = { uri: 'http://127.0.0.1:5005/tts/hi.mp3', durationMs: 2000, volume: 40 };

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
  const announcer = new Announcer({ system, logger, topologyTimeoutMs: 1000 });
  return { system, kitchen, office, den, announcer, messages };
}

/** Runs `promise` to completion while ticking mock timers; rethrows its rejection at the end. */
async function settle(promise: Promise<void>, stepMs = 500, maxSteps = 40): Promise<void> {
  let outcome: { error?: unknown } | undefined;
  promise.then(
    () => {
      outcome = {};
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
}

describe('Announcer', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('plays on one player and restores its playback afterwards', async () => {
    const { system, kitchen, announcer } = await setup();

    await settle(announcer.announce({ kind: 'player', player: kitchen.player }, CLIP));

    const [announcement, restore] = system.appliedPresets;
    assert.deepEqual(announcement, {
      players: [{ roomName: 'Kitchen', volume: 40 }],
      playMode: { repeat: 'none' },
      uri: CLIP.uri,
    });
    assert.equal(restore?.players[0]?.volume, 30);
    assert.equal(restore?.uri, 'x-rincon-queue:RINCON_K#0');
    assert.equal(restore?.state, 'STOPPED');
    assert.equal(system.appliedPresets.length, 2);
  });

  it('finishes early when the player reports STOPPED after the halfway point', async () => {
    const { system, kitchen, announcer } = await setup();
    const promise = announcer.announce({ kind: 'player', player: kitchen.player }, CLIP);
    await flushPromises();
    assert.equal(system.appliedPresets.length, 1);

    kitchen.player.emit('transport-state', { ...kitchen.player.state, playbackState: 'STOPPED' });
    mock.timers.tick(999);
    await flushPromises();
    assert.equal(system.appliedPresets.length, 1, 'ignored before half the clip has played');

    mock.timers.tick(1);
    await flushPromises();
    kitchen.player.emit('transport-state', { ...kitchen.player.state, playbackState: 'STOPPED' });
    await flushPromises();
    await promise;

    assert.equal(system.appliedPresets.length, 2);
    assert.equal(kitchen.player.listenerCount('transport-state'), 0, 'listeners are removed');
  });

  it('plays on all players through the biggest group and waits for them to regroup', async () => {
    const { system, kitchen, office, den, announcer } = await setup();
    system.zones[0]?.members.push(office.player);
    office.player.coordinator = kitchen.player;
    system.zones.splice(1, 1);
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      system.appliedPresets.push(preset);
      if (preset.uri === CLIP.uri) {
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

    await settle(announcer.announce({ kind: 'all' }, CLIP));

    const [announcement, ...restores] = system.appliedPresets;
    assert.deepEqual(announcement?.players, [
      { roomName: 'Kitchen', volume: 40 },
      { roomName: 'Office', volume: 40 },
      { roomName: 'Den', volume: 40 },
    ]);
    assert.equal(announcement?.pauseOthers, true);
    assert.equal(announcement?.state, 'STOPPED');
    assert.equal(
      kitchen.soap.calls.filter((call) => call.action.endsWith('#Play')).length,
      1,
      'played once regrouped',
    );
    assert.deepEqual(
      restores.map((preset) => preset.players.map((p) => p.roomName)),
      [['Kitchen', 'Office'], ['Den']],
      'largest group restored first',
    );
  });

  it('plays a preset, retrying the preset once and giving up waiting for the topology', async () => {
    const { system, kitchen, announcer, messages } = await setup();
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

    await settle(announcer.announce({ kind: 'preset', preset }, CLIP));

    assert.equal(kitchen.soap.calls.filter((call) => call.action.endsWith('#Pause')).length, 1);
    assert.equal(system.appliedPresets[0]?.uri, CLIP.uri);
    assert.equal(system.appliedPresets[1]?.uri, CLIP.uri, 'retried');
    assert.deepEqual(system.appliedPresets[1]?.players, preset.players);
    assert.ok(messages().includes('players did not regroup in time, playing anyway'));
    assert.equal(kitchen.soap.calls.filter((call) => call.action.endsWith('#Play')).length, 1);
  });

  it('restores even when playback fails, and reports the failure', async () => {
    const { system, kitchen, announcer, messages } = await setup();
    kitchen.soap.queueFailure(new Error('player offline'));
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      system.appliedPresets.push(preset);
      return preset.uri === CLIP.uri
        ? Promise.reject(new Error('cannot play clip'))
        : Promise.resolve();
    });

    await assert.rejects(
      settle(announcer.announce({ kind: 'player', player: kitchen.player }, CLIP)),
      /cannot play clip/,
    );

    assert.equal(system.appliedPresets.length, 2, 'the backup was still restored');
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      system.appliedPresets.push(preset);
      return preset.uri === CLIP.uri
        ? Promise.resolve()
        : Promise.reject(new Error('restore broke'));
    });
    await settle(announcer.announce({ kind: 'player', player: kitchen.player }, CLIP));
    assert.ok(messages().includes('restore failed'));
  });

  it('runs announcements one after another', async () => {
    const { system, kitchen, office, announcer } = await setup();
    const order: string[] = [];
    system.applyPreset.mock.mockImplementation((preset: Preset) => {
      order.push(
        `${preset.uri === CLIP.uri ? 'play' : 'restore'}:${preset.players[0]?.roomName ?? ''}`,
      );
      return Promise.resolve();
    });

    const first = announcer.announce({ kind: 'player', player: kitchen.player }, CLIP);
    const second = announcer.announce({ kind: 'player', player: office.player }, CLIP);
    await settle(Promise.all([first, second]).then(() => undefined));

    assert.deepEqual(order, ['play:Kitchen', 'restore:Kitchen', 'play:Office', 'restore:Office']);
  });

  it('rejects an unknown preset room and an empty system', async () => {
    const { announcer } = await setup();
    await assert.rejects(
      announcer.announce({ kind: 'preset', preset: { players: [{ roomName: 'Attic' }] } }, CLIP),
      /not a known player/,
    );
    const empty = new Announcer({ system: new FakeSystem() });
    await assert.rejects(empty.announce({ kind: 'all' }, CLIP), /No Sonos players/);
  });
});
