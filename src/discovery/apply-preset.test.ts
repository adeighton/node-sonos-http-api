import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { deferred, fakePresetPlayer } from '../testing/fake-player.ts';
import type { FakePresetPlayer } from '../testing/fake-player.ts';
import { applyPreset, isPausable, playsTvAudio } from './apply-preset.ts';
import type { PresetSystem } from './apply-preset.ts';
import { ArgumentError, RequestTimeoutError } from './errors.ts';
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
  const otherPlayer = fakePresetPlayer({
    roomName: 'Other zone',
    uuid: 'RINCON_1000000001400',
    playbackState: 'PLAYING',
  });

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

  return { system, getPlayer, byName, coordinator, member, superfluous, otherPlayer };
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

  it('retries the break-out once when the player merely timed out', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const coordinator = fakePresetPlayer({
        roomName: 'Bedroom',
        coordinatorUuid: 'RINCON_ELSEWHERE',
      });
      let calls = 0;
      coordinator.becomeCoordinatorOfStandaloneGroup.mock.mockImplementation(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new RequestTimeoutError('http://p', 10_000))
          : Promise.resolve();
      });
      const { logger, messages } = captureLogs();
      const system: PresetSystem = { getPlayer: () => coordinator, zones: [] };

      const pending = applyPreset(system, { players: [{ roomName: 'Bedroom' }] }, logger);
      await flushPromises();
      mock.timers.tick(1000);
      await flushPromises();
      await pending;

      assert.equal(coordinator.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 2);
      assert.ok(messages().includes('command failed, retrying'));
      assert.equal(coordinator.play.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('sets the uri and metadata for a uri-only preset without breaking out a lone player', async () => {
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

    assert.equal(player.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 0);
    assert.deepEqual(player.setAVTransport.mock.calls[0]?.arguments, [
      'x-rincon-stream:UUID_0000000001400',
      '<DIDL-Lite></DIDL-Lite>',
    ]);
    assert.equal(player.setVolume.mock.callCount(), 0);
  });

  it('leaves a group it leads when a single-player preset changes its uri', async () => {
    const leader = fakePresetPlayer({ roomName: 'Bedroom', avTransportUri: 'x-rincon-queue:B#0' });
    const follower = fakePresetPlayer({ roomName: 'Hall', coordinatorUuid: leader.uuid });
    const system: PresetSystem = {
      getPlayer: () => leader,
      zones: [{ uuid: leader.uuid, coordinator: leader, members: [leader, follower] }],
    };

    await applyPreset(system, { players: [{ roomName: 'Bedroom' }], uri: 'x-rincon-stream:X' });

    assert.equal(leader.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 1);
    assert.equal(follower.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 0, 'not ungrouped');
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

  it('never sends an empty uri to the player', async () => {
    const player = fakePresetPlayer({ roomName: 'Bedroom', avTransportUri: '' });
    const system: PresetSystem = {
      getPlayer: () => player,
      zones: [{ uuid: player.uuid, coordinator: player, members: [player] }],
    };

    await applyPreset(system, { players: [{ roomName: 'Bedroom' }], uri: '', state: 'STOPPED' });

    assert.equal(player.setAVTransport.mock.callCount(), 0);
    assert.equal(player.play.mock.callCount(), 0);
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

  it('pauses only the other zones that are actually playing', async () => {
    const { system, otherPlayer } = groupedSystem();
    const idle = fakePresetPlayer({ roomName: 'Idle zone', uuid: 'RINCON_IDLE' });
    system.zones.push({ uuid: idle.uuid, coordinator: idle, members: [idle] });

    await applyPreset(system, fullPreset());

    assert.equal(otherPlayer.pause.mock.callCount(), 1, 'the playing zone is paused');
    assert.equal(idle.pause.mock.callCount(), 0, 'a stopped zone is left alone');
  });

  it('never pauses a player that is playing its TV input', async () => {
    const { system, otherPlayer } = groupedSystem();
    otherPlayer.avTransportUri = 'x-sonos-htastream:RINCON_1000000001400:spdif';
    assert.equal(playsTvAudio(otherPlayer), true);
    assert.equal(isPausable(otherPlayer), false);

    await applyPreset(system, { ...fullPreset(), pauseOthers: true });

    assert.equal(otherPlayer.pause.mock.callCount(), 0, 'the film goes on');
    otherPlayer.state.playbackState = 'STOPPED';
    assert.equal(playsTvAudio(otherPlayer), false, 'an idle TV input is not "watching TV"');
  });

  it('issues member joins, volumes and pauses concurrently, in the documented order', async () => {
    const { system, byName, coordinator, member, superfluous, otherPlayer } = groupedSystem();
    const secondMember = fakePresetPlayer({
      roomName: 'Hall',
      uuid: 'RINCON_HALL',
      coordinatorUuid: coordinator.uuid,
    });
    system.zones[0]?.members.push(secondMember);
    byName.Hall = secondMember;
    const joinA = deferred();
    const joinB = deferred();
    member.setAVTransport.mock.mockImplementation(() => joinA.promise);
    secondMember.setAVTransport.mock.mockImplementation(() => joinB.promise);
    const pending = applyPreset(system, {
      players: [
        { roomName: 'Kitchen', volume: 5 },
        { roomName: 'Other room', volume: 6 },
        { roomName: 'Hall', volume: 7 },
      ],
      pauseOthers: true,
      uri: 'x-file-cifs://nas/clip.mp3',
    });
    await flushPromises();

    // Both joins were started without waiting for each other.
    assert.equal(member.setAVTransport.mock.callCount(), 1);
    assert.equal(secondMember.setAVTransport.mock.callCount(), 1);
    assert.equal(coordinator.setAVTransport.mock.callCount(), 0, 'transport waits for the group');
    joinA.release();
    joinB.release();
    await pending;

    assert.equal(superfluous.becomeCoordinatorOfStandaloneGroup.mock.callCount(), 1);
    assert.equal(otherPlayer.pause.mock.callCount(), 1);
    assert.deepEqual(coordinator.setAVTransport.mock.calls[0]?.arguments, [
      'x-file-cifs://nas/clip.mp3',
      undefined,
    ]);
    assert.deepEqual(
      [coordinator, member, secondMember].map((p) => p.setVolume.mock.calls[0]?.arguments[0]),
      [5, 6, 7],
    );
    assert.equal(coordinator.play.mock.callCount(), 1);
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
