import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { NotFoundError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerLineInActions } from './linein.ts';
import { ActionRegistry } from './registry.ts';

describe('linein action', () => {
  it('plays this room’s or another room’s line-in', async () => {
    const registry = new ActionRegistry();
    registerLineInActions(registry);
    const { context, rooms } = createActionContext({ rooms: ['Kitchen', 'Office'] });
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const linein = registry.get('linein');
    assert.ok(linein);

    await linein(context, []);
    await linein(context, ['office']);

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.Play,
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.Play,
      ],
    );
    assert.equal(kitchen.soap.calls[0]?.values?.uri, 'x-rincon-stream:RINCON_0');
    assert.equal(kitchen.soap.calls[2]?.values?.uri, 'x-rincon-stream:RINCON_1');
    await assert.rejects(linein(context, ['Attic']), NotFoundError);
  });
});
