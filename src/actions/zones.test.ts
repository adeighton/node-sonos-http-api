import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { registerZoneActions } from './zones.ts';
import type { simplifyZones } from './zones.ts';

describe('zones action', () => {
  it('describes every zone with coordinator and members in the legacy shape', async () => {
    const registry = new ActionRegistry();
    registerZoneActions(registry);
    const { context, system, rooms } = createActionContext({ rooms: ['Kitchen', 'Office'] });
    const office = rooms.get('Office');
    assert.ok(office);
    office.player.groupState.volume = 12;

    const zones = (await registry.get('zones')?.(context, [])) as ReturnType<typeof simplifyZones>;

    assert.equal(zones.length, 2);
    assert.equal(zones[1]?.uuid, 'RINCON_1');
    assert.deepEqual(Object.keys(zones[1]?.coordinator ?? {}), [
      'uuid',
      'state',
      'roomName',
      'coordinator',
      'groupState',
    ]);
    assert.equal(zones[1]?.coordinator.roomName, 'Office');
    assert.equal(zones[1]?.coordinator.coordinator, 'RINCON_1');
    assert.deepEqual(zones[1]?.coordinator.groupState, { volume: 12, mute: false });
    assert.equal(zones[1]?.members[0]?.uuid, 'RINCON_1');
    assert.deepEqual(JSON.parse(JSON.stringify(zones)), zones, 'plain data, safe to serialize');
    assert.equal(system.zones.length, 2);
  });
});
