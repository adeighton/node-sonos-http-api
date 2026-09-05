import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerMuteActions } from './mute.ts';
import { ActionRegistry } from './registry.ts';

describe('mute actions', () => {
  it('mutes, unmutes and toggles, group variants via the coordinator', async () => {
    const registry = new ActionRegistry();
    registerMuteActions(registry);
    const { context, rooms } = createActionContext({ rooms: ['Kitchen', 'Office'] });
    const kitchen = rooms.get('Kitchen');
    const office = rooms.get('Office');
    assert.ok(kitchen && office);
    kitchen.player.coordinator = office.player;

    await registry.get('mute')?.(context, []);
    await registry.get('unmute')?.(context, []);
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.values),
      [{ mute: 1 }, { mute: 0 }],
    );

    await registry.get('mutegroup')?.(context, []);
    await registry.get('unmutegroup')?.(context, []);
    assert.deepEqual(
      office.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.GroupMute, SOAP_ACTIONS.GroupMute],
    );

    assert.deepEqual(await registry.get('togglemute')?.(context, []), {
      status: 'success',
      muted: true,
    });
    await kitchen.player.handleLastChange({ mute: [{ channel: 'Master', val: '1' }] });
    assert.deepEqual(await registry.get('togglemute')?.(context, []), {
      status: 'success',
      muted: false,
    });
    assert.deepEqual(
      kitchen.soap.calls.slice(2).map((c) => c.values),
      [{ mute: 1 }, { mute: 0 }],
    );
  });
});
