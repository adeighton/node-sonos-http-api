import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnknownServiceError } from '../discovery/errors.ts';
import { FakeSystem } from './fake-system.ts';
import { createTestPlayer } from './test-player.ts';

describe('FakeSystem', () => {
  it('records emitted events and serves canned favorites', async () => {
    const system = new FakeSystem();
    system.favorites = [{ uri: 'x', title: 'Fav' }];

    system.emit('list-change', 'favorites');

    assert.deepEqual(system.emitted, [{ event: 'list-change', args: ['favorites'] }]);
    assert.deepEqual(await system.getFavorites(), [{ uri: 'x', title: 'Fav' }]);
    assert.deepEqual(await system.getPlaylists(), []);
  });

  it('registers standalone players and finds them by name or uuid', () => {
    const system = new FakeSystem();
    const { player } = createTestPlayer({ system, roomName: 'Kitchen' });

    const zone = system.addStandalone(player);

    assert.equal(zone.coordinator, player);
    assert.deepEqual(zone.members, [player]);
    assert.equal(system.getPlayer('kitchen'), player);
    assert.equal(system.getPlayerByUUID(player.uuid), player);
    assert.equal(system.getPlayer('Office'), undefined);
    assert.deepEqual(system.zones, [zone]);
  });

  it('round-robins any player and records applied presets', async () => {
    const system = new FakeSystem();
    assert.equal(system.getAnyPlayer(), undefined);
    const a = createTestPlayer({ system, roomName: 'A', uuid: 'RINCON_A' }).player;
    const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' }).player;
    system.addStandalone(a);
    system.addStandalone(b);

    assert.equal(system.getAnyPlayer(), a);
    assert.equal(system.getAnyPlayer(), b);
    assert.equal(system.getAnyPlayer(), a);

    await system.applyPreset({ players: [{ roomName: 'A' }] });
    assert.deepEqual(system.appliedPresets, [{ players: [{ roomName: 'A' }] }]);
    await system.refreshShareIndex();
    assert.equal(system.refreshShareIndex.mock.callCount(), 1);
  });

  it('looks up services and rejects unknown ones', () => {
    const system = new FakeSystem();
    system.availableServices = { Spotify: { id: 9, capabilities: 1, type: 2311 } };

    assert.equal(system.getServiceId('Spotify'), 9);
    assert.equal(system.getServiceType('Spotify'), 2311);
    assert.throws(() => system.getServiceId('Tidal'), UnknownServiceError);
  });
});
