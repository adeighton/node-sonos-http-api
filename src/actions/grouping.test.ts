import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerGroupingActions } from './grouping.ts';
import { ActionRegistry } from './registry.ts';

describe('grouping actions', () => {
  it('add, join and isolate use x-rincon uris of the right coordinator', async () => {
    const registry = new ActionRegistry();
    registerGroupingActions(registry);
    const { context, rooms } = createActionContext({ rooms: ['Kitchen', 'Office', 'Den'] });
    const kitchen = rooms.get('Kitchen');
    const office = rooms.get('Office');
    const den = rooms.get('Den');
    assert.ok(kitchen && office && den);
    office.player.coordinator = den.player; // Office is grouped under Den

    await registry.get('add')?.(context, ['office']);
    assert.deepEqual(office.soap.calls[0]?.values, { uri: 'x-rincon:RINCON_0', metadata: '' });

    await registry.get('join')?.(context, ['Office']);
    assert.deepEqual(kitchen.soap.calls[0]?.values, { uri: 'x-rincon:RINCON_2', metadata: '' });

    for (const name of ['isolate', 'ungroup', 'leave']) {
      await registry.get(name)?.(context, []);
    }
    assert.equal(
      kitchen.soap.calls.filter((c) => c.action === SOAP_ACTIONS.BecomeCoordinatorOfStandaloneGroup)
        .length,
      3,
    );

    await assert.rejects(
      registry.get('add')?.(context, ['Attic']) ?? Promise.reject(new Error()),
      NotFoundError,
    );
    await assert.rejects(
      registry.get('join')?.(context, []) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });
});
