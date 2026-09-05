import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { flushPromises } from '../testing/async.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerLockVolumeActions } from './lockvolumes.ts';
import { ActionRegistry } from './registry.ts';

describe('lockvolumes / unlockvolumes', () => {
  it('reverts volume changes while locked and stops after unlocking', async () => {
    const registry = new ActionRegistry();
    registerLockVolumeActions(registry);
    const { context, rooms, system } = createActionContext({ rooms: ['Kitchen'] });
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    await kitchen.player.handleLastChange({ volume: [{ channel: 'Master', val: '20' }] });

    await registry.get('lockvolumes')?.(context, []);
    await kitchen.player.handleLastChange({ volume: [{ channel: 'Master', val: '35' }] });
    await flushPromises();

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.values),
      [{ volume: 20 }],
    );
    assert.equal(kitchen.soap.calls[0]?.action, SOAP_ACTIONS.Volume);

    // A change back to the locked value is left alone.
    await kitchen.player.handleLastChange({ volume: [{ channel: 'Master', val: '20' }] });
    await flushPromises();
    assert.equal(kitchen.soap.calls.length, 1);

    await registry.get('unlockvolumes')?.(context, []);
    await kitchen.player.handleLastChange({ volume: [{ channel: 'Master', val: '50' }] });
    await flushPromises();
    assert.equal(kitchen.soap.calls.length, 1);
    assert.equal(system.listenerCount('volume-change'), 1, 'only the FakeSystem recorder remains');
  });
});
