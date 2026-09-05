import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

  it('registers standalone players and finds them case-insensitively', () => {
    const system = new FakeSystem();
    const { player } = createTestPlayer({ system, roomName: 'Kitchen' });

    const zone = system.addStandalone(player);

    assert.equal(zone.coordinator, player);
    assert.deepEqual(zone.members, [player]);
    assert.equal(system.getPlayer('kitchen'), player);
    assert.equal(system.getPlayer('Office'), undefined);
    assert.deepEqual(system.zones, [zone]);
  });
});
