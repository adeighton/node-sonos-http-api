import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakePresetPlayer } from './fake-player.ts';

describe('fakePresetPlayer', () => {
  it('derives a uuid, coordinates itself and resolves every command', async () => {
    const player = fakePresetPlayer({ roomName: 'Living Room' });

    assert.equal(player.uuid, 'RINCON_LIVINGROOM');
    assert.equal(player.coordinator.uuid, 'RINCON_LIVINGROOM');
    assert.equal(player.avTransportUri, '');
    await player.setVolume('+3');
    await player.setAVTransport('x-rincon:RINCON_X', '<m/>');
    assert.deepEqual(player.setVolume.mock.calls[0]?.arguments, ['+3']);
    assert.deepEqual(player.setAVTransport.mock.calls[0]?.arguments, ['x-rincon:RINCON_X', '<m/>']);
  });

  it('accepts explicit uuid, coordinator and transport uri', () => {
    const player = fakePresetPlayer({
      roomName: 'Office',
      uuid: 'RINCON_1',
      coordinatorUuid: 'RINCON_2',
      avTransportUri: 'x-rincon:RINCON_2',
    });

    assert.equal(player.uuid, 'RINCON_1');
    assert.equal(player.coordinator.uuid, 'RINCON_2');
    assert.equal(player.avTransportUri, 'x-rincon:RINCON_2');
  });
});
