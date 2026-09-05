import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import {
  captureAllBackups,
  capturePlayerBackup,
  hasQueuePosition,
  isGroupLink,
  isRadioOrLineIn,
  isRestorableUri,
  restorePreset,
} from './backup.ts';

async function playing(
  system: FakeSystem,
  room: string,
  uuid: string,
  volume: number,
  uri: string,
) {
  const { player } = createTestPlayer({ system, roomName: room, uuid });
  await player.handleLastChange({ volume: [{ channel: 'Master', val: String(volume) }] });
  await player.handleLastChange({
    transportstate: { val: 'PAUSED_PLAYBACK' },
    currenttrack: { val: '4' },
    currentplaymode: { val: 'REPEAT_ALL' },
    avtransporturi: { val: 'x-rincon:SKIP' }, // grouped shape: no position lookup in tests
  });
  await player.setAVTransport(uri, '<m/>');
  return player;
}

describe('isRadioOrLineIn', () => {
  it('recognizes streams and line-in', () => {
    assert.equal(isRadioOrLineIn('x-sonosapi-stream:s1'), true);
    assert.equal(isRadioOrLineIn('x-rincon-stream:RINCON_1'), true);
    assert.equal(isRadioOrLineIn('x-rincon-queue:RINCON_1#0'), false);
  });
});

describe('isRestorableUri', () => {
  it('rejects an empty transport and app-pushed sessions', () => {
    assert.equal(isRestorableUri(''), false);
    assert.equal(isRestorableUri('x-sonos-vli:RINCON_1:2,airplay:abc'), false);
    assert.equal(isRestorableUri('x-rincon-queue:RINCON_1#0'), true);
    assert.equal(isRestorableUri('x-sonosapi-stream:s1'), true);
  });
});

describe('hasQueuePosition', () => {
  it('is only true for a queue with a current track', () => {
    assert.equal(hasQueuePosition('x-rincon-queue:RINCON_1#0', 3), true);
    assert.equal(hasQueuePosition('x-rincon-queue:RINCON_1#0', 0), false, 'empty queue');
    assert.equal(hasQueuePosition('x-rincon:RINCON_1', 1), false, 'group link');
    assert.equal(hasQueuePosition('x-sonosapi-stream:s1', 1), false, 'stream');
    assert.equal(isGroupLink('x-rincon:RINCON_1'), true);
    assert.equal(isGroupLink('x-rincon-queue:RINCON_1#0'), false);
  });
});

describe('capturePlayerBackup', () => {
  it('backs up a standalone player with its playback position', async () => {
    const system = new FakeSystem();
    const player = await playing(system, 'Kitchen', 'RINCON_K', 30, 'x-rincon-queue:RINCON_K#0');
    system.addStandalone(player);

    const backup = capturePlayerBackup(system, player);

    assert.deepEqual(backup, {
      preset: {
        players: [{ roomName: 'Kitchen', volume: 30 }],
        state: 'PAUSED_PLAYBACK',
        uri: 'x-rincon-queue:RINCON_K#0',
        metadata: '<m/>',
        playMode: { repeat: 'all' },
        trackNo: 4,
        elapsedTime: 0,
      },
    });
  });

  it('falls back to the stopped queue when the player had no transport or an AirPlay session', async () => {
    const system = new FakeSystem();
    const idle = createTestPlayer({ system, roomName: 'Family Room', uuid: 'RINCON_F' }).player;
    await idle.handleLastChange({
      transportstate: { val: 'PLAYING' },
      currenttrack: { val: '1' },
      currentplaymode: { val: 'REPEAT_ALL' },
    });
    system.addStandalone(idle);
    assert.equal(idle.avTransportUri, '');

    const backup = capturePlayerBackup(system, idle);

    assert.deepEqual(backup.preset, {
      players: [{ roomName: 'Family Room', volume: 0 }],
      state: 'STOPPED',
      uri: 'x-rincon-queue:RINCON_F#0',
      metadata: '',
      playMode: { repeat: 'all' },
    });

    const airplay = await playing(
      system,
      'Den',
      'RINCON_D',
      20,
      'x-sonos-vli:RINCON_D:2,airplay:x',
    );
    system.addStandalone(airplay);
    const all = captureAllBackups(system).find((b) => b.preset.players[0]?.roomName === 'Den');
    assert.equal(all?.preset.uri, 'x-rincon-queue:RINCON_D#0');
    assert.equal(all?.preset.state, 'STOPPED');
  });

  it('omits the position for a stopped player with an empty queue', async () => {
    const system = new FakeSystem();
    const { player } = createTestPlayer({ system, roomName: 'Kitchen', uuid: 'RINCON_K' });
    await player.handleLastChange({
      transportstate: { val: 'STOPPED' },
      currenttrack: { val: '0' },
      avtransporturi: { val: 'x-rincon-queue:RINCON_K#0' },
    });
    system.addStandalone(player);

    const backup = capturePlayerBackup(system, player);

    assert.equal(backup.preset.state, 'STOPPED');
    assert.equal('trackNo' in backup.preset, false);
    assert.equal('elapsedTime' in backup.preset, false);
  });

  it('omits the position when the topology still shows a rejoining player as standalone', async () => {
    // Right after an announcement the player has been told to follow its old group again, but
    // the topology event has not arrived yet: it looks standalone with an x-rincon: transport.
    const system = new FakeSystem();
    const player = await playing(system, 'Kitchen', 'RINCON_K', 30, 'x-rincon:RINCON_F');
    system.addStandalone(player);

    const backup = capturePlayerBackup(system, player);

    assert.equal(backup.preset.uri, 'x-rincon:RINCON_F');
    assert.equal('trackNo' in backup.preset, false);
  });

  it('omits the position for radio and remembers the coordinator for members', async () => {
    const system = new FakeSystem();
    const radio = await playing(system, 'Den', 'RINCON_D', 10, 'x-sonosapi-stream:s1?sid=254');
    system.addStandalone(radio);
    const member = createTestPlayer({ system, roomName: 'Hall', uuid: 'RINCON_H' }).player;
    member.coordinator = radio;
    system.zones[0]?.members.push(member);

    const radioBackup = capturePlayerBackup(system, radio);
    assert.equal('trackNo' in radioBackup.preset, false);
    assert.deepEqual(
      radioBackup.rejoinMembers,
      ['RINCON_H'],
      'a coordinator with members rejoins them',
    );

    const memberBackup = capturePlayerBackup(system, member);
    assert.deepEqual(memberBackup, {
      preset: { players: [{ roomName: 'Hall', volume: 0 }], uri: 'x-rincon:RINCON_D' },
    });
  });
});

describe('captureAllBackups / restorePreset', () => {
  it('backs up every group, largest first, and rejoins the former group through its current coordinator', async () => {
    const system = new FakeSystem();
    const a = await playing(system, 'A', 'RINCON_A', 10, 'x-rincon-queue:RINCON_A#0');
    const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' }).player;
    const c = await playing(system, 'C', 'RINCON_C', 20, 'x-sonosapi-stream:s2');
    system.addStandalone(c);
    const zone = system.addStandalone(a);
    b.coordinator = a;
    zone.members.push(b);

    const backups = captureAllBackups(system);

    assert.deepEqual(
      backups.map((backup) => backup.preset.players.map((p) => p.roomName)),
      [['A', 'B'], ['C']],
    );
    assert.equal(backups[0]?.preset.trackNo, 4);
    assert.equal(backups[1]?.preset.trackNo, undefined);

    // A left its group; B now coordinates. Restoring A should rejoin B.
    const aBackup = capturePlayerBackup(system, a);
    system.zones = [
      { uuid: 'RINCON_B', id: 'RINCON_B:9', coordinator: b, members: [b] },
      { uuid: 'RINCON_A', id: 'RINCON_A:9', coordinator: a, members: [a] },
    ];
    b.coordinator = b;
    assert.equal(restorePreset(system, aBackup).uri, 'x-rincon:RINCON_B');

    system.zones = [];
    assert.equal(
      restorePreset(system, aBackup).uri,
      undefined,
      'no rejoin when the group vanished',
    );
    assert.equal(restorePreset(system, backups[1] as never), backups[1]?.preset);
  });
});
