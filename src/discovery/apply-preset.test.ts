import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { fakePresetPlayer } from '../testing/fake-player.ts';
import type { FakePresetPlayer } from '../testing/fake-player.ts';
import { applyPreset } from './apply-preset.ts';
import type { PresetSystem } from './apply-preset.ts';
import { ArgumentError } from './errors.ts';
import type { Preset } from './types.ts';

function fullPreset(): Preset {
  return {
    players: [
      { roomName: 'Kitchen', volume: 1 },
      { roomName: 'Other room', volume: 2 },
      { roomName: 'Office', volume: 3, mute: true },
    ],
    playMode: { crossfade: true, repeat: 'all', shuffle: true },
    pauseOthers: true,
    favorite: 'My favorite',
    trackNo: 12,
    elapsedTime: 120,
    state: 'playing',
    sleep: 600,
  };
}

/** The legacy test setup: a coordinator with a member, a superfluous member, and another zone. */
function groupedSystem() {
  const coordinator = fakePresetPlayer({ roomName: 'Kitchen', uuid: 'RINCON_0000000001400' });
  const member = fakePresetPlayer({
    roomName: 'Member',
    uuid: 'RINCON_0100000001400',
    coordinatorUuid: 'RINCON_0000000001400',
  });
  const superfluous = fakePresetPlayer({
    roomName: 'Superfluous',
    uuid: 'RINCON_0200000001400',
    coordinatorUuid: 'RINCON_0000000001400',
  });
  const otherPlayer = fakePresetPlayer({ roomName: 'Other zone', uuid: 'RINCON_1000000001400' });

  const byName: Record<string, FakePresetPlayer> = {
    Kitchen: coordinator,
    'Other room': member,
    Office: member,
  };
  const getPlayer = mock.fn((roomName: string) => byName[roomName]);
  const system: PresetSystem = {
    getPlayer,
    zones: [
      { uuid: coordinator.uuid, coordinator, members: [coordinator, member, superfluous] },
      { uuid: otherPlayer.uuid, coordinator: otherPlayer, members: [otherPlayer] },
    ],
  };

  return { system, getPlayer, coordinator, member, superfluous, otherPlayer };
}

describe('applyPreset', () => {
  describe('with a full preset on a grouped system', () => {
    it('pauses the other zones but not the preset coordinator', async () => {
      const { system, coordinator, otherPlayer } = groupedSystem();
      await applyPreset(system, fullPreset());

      assert.equal(coordinator.pause.mock.callCount(), 0);
      assert.equal(otherPlayer.pause.mock.callCount(), 1);
    });

    it('looks the players up by room name in preset order', async () => {
      const { system, getPlayer } = groupedSystem();
      await applyPreset(system, fullPreset());

      assert.deepEqual(
        getPlayer.mock.calls.slice(0, 3).map((call) => call.arguments[0]),
        ['Kitchen', 'Other room', 'Office'],
      );
    });

    it('sets volumes and mutes per preset entry', async () => {
      const { system, coordinator, member } = groupedSystem();
      await applyPreset(system, fullPreset());

      assert.deepEqual(
        coordinator.setVolume.mock.calls.map((call) => call.arguments[0]),
        [1],
      );
      assert.deepEqual(
        member.setVolume.mock.calls.map((call) => call.arguments[0]),
        [2, 3],
      );
      assert.equal(member.mute.mock.callCount(), 1);
      assert.equal(member.unMute.mock.callCount(), 0);
    });

    it('does not break out the coordinator when it already coordinates', async () => {
      const { system, coordinator } = groupedSystem();
      await applyPreset(system, fullPreset());

      assert.equal(coordinator.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 0);
    });

    it('groups the members with the coordinator and ungroups the rest', async () => {
      const { system, member, superfluous } = groupedSystem();
      await applyPreset(system, fullPreset());

      assert.deepEqual(
        member.setAVTransport.mock.calls.map((call) => call.arguments[0]),
        ['x-rincon:RINCON_0000000001400', 'x-rincon:RINCON_0000000001400'],
      );
      assert.equal(superfluous.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 1);
    });

    it('replaces the queue with the favorite and applies play mode, position, sleep and play', async () => {
      const { system, coordinator } = groupedSystem();
      const preset = fullPreset();
      await applyPreset(system, preset);

      assert.deepEqual(coordinator.replaceWithFavorite.mock.calls[0]?.arguments, ['My favorite']);
      assert.deepEqual(coordinator.setPlayMode.mock.calls[0]?.arguments, [preset.playMode]);
      assert.deepEqual(coordinator.trackSeek.mock.calls[0]?.arguments, [12]);
      assert.deepEqual(coordinator.timeSeek.mock.calls[0]?.arguments, [120]);
      assert.deepEqual(coordinator.sleep.mock.calls[0]?.arguments, [600]);
      assert.equal(coordinator.play.mock.callCount(), 1);
    });

    it('un-mutes when mute is false', async () => {
      const { system, member } = groupedSystem();
      const preset = fullPreset();
      preset.players[2] = { roomName: 'Office', volume: 3, mute: false };
      await applyPreset(system, preset);

      assert.equal(member.mute.mock.callCount(), 0);
      assert.equal(member.unMute.mock.callCount(), 1);
    });

    it('skips already grouped members', async () => {
      const { system, member } = groupedSystem();
      member.avTransportUri = 'x-rincon:RINCON_0000000001400';
      await applyPreset(system, fullPreset());

      assert.equal(member.setAVTransport.mock.callCount(), 0);
    });
  });

  it('breaks out the first player when it is a member of another group', async () => {
    const coordinator = fakePresetPlayer({
      roomName: 'Bedroom',
      uuid: 'RINCON_10000000001400',
      coordinatorUuid: 'RINCON_0000000001400',
    });
    const other = fakePresetPlayer({ roomName: 'Kitchen', uuid: 'RINCON_0000000001400' });
    const system: PresetSystem = {
      getPlayer: (roomName) => (roomName === 'Bedroom' ? coordinator : other),
      zones: [{ uuid: other.uuid, coordinator: other, members: [other, coordinator] }],
    };

    await applyPreset(system, {
      players: [
        { roomName: 'Bedroom', volume: 1 },
        { roomName: 'Kitchen', volume: 2 },
      ],
    });

    assert.equal(coordinator.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 1);
    assert.equal(coordinator.pause.mock.callCount(), 0);
    assert.deepEqual(other.setAVTransport.mock.calls[0]?.arguments, [
      'x-rincon:RINCON_10000000001400',
    ]);
    assert.equal(coordinator.play.mock.callCount(), 1);
  });

  it('rethrows when breaking out the coordinator fails', async () => {
    const coordinator = fakePresetPlayer({
      roomName: 'Bedroom',
      coordinatorUuid: 'RINCON_ELSEWHERE',
    });
    coordinator.becomeCoordinatorOfStandaloneGroup.mock.mockImplementation(() =>
      Promise.reject(new Error('player busy')),
    );
    const { logger, messages } = captureLogs();
    const system: PresetSystem = { getPlayer: () => coordinator, zones: [] };

    await assert.rejects(
      applyPreset(system, { players: [{ roomName: 'Bedroom' }] }, logger),
      /player busy/,
    );
    assert.ok(messages().includes('failed to break out coordinator'));
    assert.equal(coordinator.play.mock.callCount(), 0);
  });

  it('sets the uri and metadata for a uri-only preset (breaking out first)', async () => {
    const player = fakePresetPlayer({ roomName: 'Bedroom', uuid: 'RINCON_0000000001400' });
    const system: PresetSystem = {
      getPlayer: () => player,
      zones: [{ uuid: player.uuid, coordinator: player, members: [player] }],
    };

    await applyPreset(system, {
      players: [{ roomName: 'Bedroom' }],
      uri: 'x-rincon-stream:UUID_0000000001400',
      metadata: '<DIDL-Lite></DIDL-Lite>',
    });

    assert.equal(player.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 1);
    assert.deepEqual(player.setAVTransport.mock.calls[0]?.arguments, [
      'x-rincon-stream:UUID_0000000001400',
      '<DIDL-Lite></DIDL-Lite>',
    ]);
    assert.equal(player.setVolume.mock.callCount(), 0);
  });

  it('does not break out a single player that already plays the preset uri', async () => {
    const player = fakePresetPlayer({ roomName: 'Bedroom', avTransportUri: 'x-rincon-stream:X' });
    const system: PresetSystem = {
      getPlayer: () => player,
      zones: [{ uuid: player.uuid, coordinator: player, members: [player] }],
    };

    await applyPreset(system, { players: [{ roomName: 'Bedroom' }], uri: 'x-rincon-stream:X' });

    assert.equal(player.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 0);
  });

  it('uses the playlist when no favorite is given and leaves a stopped preset stopped', async () => {
    const { system, coordinator } = groupedSystem();
    const preset = fullPreset();
    delete preset.favorite;
    preset.playlist = 'Morning';
    preset.state = 'STOPPED';

    await applyPreset(system, preset);

    assert.equal(coordinator.replaceWithFavorite.mock.callCount(), 0);
    assert.deepEqual(coordinator.replaceWithPlaylist.mock.calls[0]?.arguments, ['Morning']);
    assert.equal(coordinator.play.mock.callCount(), 0);
  });

  it('swallows member group/ungroup failures, other-zone pause failures and seek failures', async () => {
    const { system, coordinator, member, superfluous, otherPlayer } = groupedSystem();
    const failing = () => Promise.reject(new Error('nope'));
    member.setAVTransport.mock.mockImplementation(failing);
    superfluous.becomeCoordinatorOfStandaloneGroup.mock.mockImplementation(failing);
    otherPlayer.pause.mock.mockImplementation(failing);
    coordinator.setPlayMode.mock.mockImplementation(failing);
    coordinator.trackSeek.mock.mockImplementation(failing);
    coordinator.timeSeek.mock.mockImplementation(failing);
    const { logger, messages } = captureLogs();

    await applyPreset(system, fullPreset(), logger);

    assert.equal(coordinator.play.mock.callCount(), 1);
    for (const expected of [
      'failed to add player to group',
      'failed to ungroup player',
      'setPlayMode failed',
      'trackSeek failed',
      'timeSeek failed',
    ]) {
      assert.ok(messages().includes(expected), expected);
    }
  });

  it('rejects unknown rooms and empty presets with an ArgumentError', async () => {
    const system: PresetSystem = { getPlayer: () => undefined, zones: [] };

    await assert.rejects(
      applyPreset(system, { players: [{ roomName: 'Attic' }] }),
      (error: unknown) => error instanceof ArgumentError && /Attic/.test(error.message),
    );
    await assert.rejects(applyPreset(system, { players: [] }), ArgumentError);
  });
});
