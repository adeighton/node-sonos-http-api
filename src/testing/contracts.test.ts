import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActionRegistry } from '../actions/index.ts';
import { createApp } from '../app.ts';
import { settingsSchema } from '../config/schema.ts';
import { getPlayMode } from '../discovery/player-state.ts';
import type { RepeatMode } from '../discovery/player-state.ts';
import { EventHub } from '../http/events.ts';
import { silentLogger } from '../logger.ts';
import { PresetStore } from '../presets/store.ts';
import {
  expectErrorContract,
  expectGroupingRoundTrip,
  expectMuteRoundTrip,
  expectPlayModeRoundTrip,
  expectStateShape,
  expectVolumeRoundTrip,
  expectZonesShape,
} from './contracts.ts';
import { FakeSystem } from './fake-system.ts';
import { LiveHarness } from './live-harness.ts';
import { createTestPlayer } from './test-player.ts';

function setup(roomNames = ['Kitchen', 'Den']) {
  const system = new FakeSystem();
  const rooms = new Map(
    roomNames.map((name, index) => {
      const created = createTestPlayer({ system, roomName: name, uuid: `RINCON_${index}` });
      system.addStandalone(created.player);
      return [name, created];
    }),
  );
  const app = createApp({
    system,
    settings: settingsSchema.parse({}),
    registry: createActionRegistry({ cacheDir: '/tmp' }),
    presets: new PresetStore('/nonexistent'),
    tts: { providers: [], speak: () => Promise.reject(new Error('no tts')) },
    clips: { get: () => Promise.reject(new Error('no clips')) },
    announcer: { announce: () => Promise.resolve() },
    hub: new EventHub({ logger: silentLogger }),
    logger: silentLogger,
    version: 'test',
    publicBaseUrl: () => 'http://127.0.0.1:5005',
  });
  const harness = new LiveHarness({
    fetch: async (url, init) => app.request(url, init),
    rooms: roomNames,
  });
  return { harness, system, rooms };
}

describe('shared action contracts (over fakes)', () => {
  it('volume: absolute and relative values read back through /state', async () => {
    const { harness } = setup();
    await expectVolumeRoundTrip(harness, 'Kitchen');
  });

  it('mute: on and off read back once the player reports it', async () => {
    const { harness, rooms } = setup();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    await expectMuteRoundTrip(harness, 'Kitchen', {
      // The fake player only learns about mute from an event, as the real one does.
      afterCommand: async (action) => {
        await kitchen.player.handleLastChange({
          mute: [{ channel: 'Master', val: action === 'mute' ? '1' : '0' }],
        });
      },
    });
  });

  it('play mode: repeat, shuffle and crossfade read back', async () => {
    const { harness, rooms } = setup();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    await expectPlayModeRoundTrip(harness, 'Kitchen', {
      // Feed the LastChange event a real player sends after SetPlayMode / SetCrossfadeMode.
      afterCommand: async (action, value) => {
        const current = kitchen.player.state.playMode;
        const repeat = (action === 'repeat' ? value : current.repeat) as RepeatMode;
        const shuffle = action === 'shuffle' ? value === 'on' : current.shuffle;
        const crossfade = action === 'crossfade' ? value === 'on' : current.crossfade;
        await kitchen.player.handleLastChange({
          transportstate: { val: 'STOPPED' },
          currentplaymode: { val: getPlayMode({ shuffle, repeat }) },
          currentcrossfademode: { val: crossfade ? '1' : '0' },
        });
      },
    });
  });

  it('grouping: join then leave read back through /zones', async () => {
    const { harness, rooms } = setup();
    const kitchen = rooms.get('Kitchen');
    const den = rooms.get('Den');
    assert.ok(kitchen && den);
    await expectGroupingRoundTrip(harness, 'Den', 'Kitchen', {
      afterCommand: (action) => {
        // A real system answers with a topology event; the fake flips the coordinator directly.
        den.player.coordinator = action === 'join' ? kitchen.player : den.player;
        return Promise.resolve();
      },
    });
  });

  it('state and zones documents have the documented shape', async () => {
    const { harness } = setup();
    await expectStateShape(harness, 'Kitchen');
    await expectZonesShape(harness);
  });

  it('errors: unknown action 404, bad volume 400, non-GET 405 with Allow', async () => {
    const { harness } = setup();
    await expectErrorContract(harness, 'Kitchen');
  });
});
