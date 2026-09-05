import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import {
  captureAllBackups,
  capturePlayerBackup,
  isRadioOrLineIn,
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
