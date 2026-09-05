import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerBbcSoundsActions } from './bbc-sounds.ts';
import { ActionRegistry } from './registry.ts';
import { registerTuneInActions } from './tunein.ts';

describe('radio actions', () => {
  it('tunein builds the stream uri and metadata from the service table', async () => {
    const registry = new ActionRegistry();
    registerTuneInActions(registry);
    const { context, rooms, system } = createActionContext();
    system.availableServices = { TuneIn: { id: 254, capabilities: 0, type: 65031 } };
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const tunein = registry.get('tunein');
    assert.ok(tunein);

    await tunein(context, ['play', 's12345']);
    await tunein(context, ['set', 's12345']);

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.SetAVTransportURI, SOAP_ACTIONS.Play, SOAP_ACTIONS.SetAVTransportURI],
    );
    assert.equal(
      kitchen.soap.calls[0]?.values?.uri,
      'x-sonosapi-stream:ss12345?sid=254&amp;flags=8224&amp;sn=0',
    );
    assert.ok(String(kitchen.soap.calls[0]?.values?.metadata).includes('SA_RINCON65031_'));
    await assert.rejects(tunein(context, ['pause', 's1']), BadRequestError);
    await assert.rejects(tunein(context, ['play']), BadRequestError);
  });

  it('bbcsounds builds the hls uri and metadata', async () => {
    const registry = new ActionRegistry();
    registerBbcSoundsActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const bbc = registry.get('bbcsounds');
    assert.ok(bbc);

    await bbc(context, ['set', 'bbc_radio_two']);

    assert.equal(kitchen.soap.calls.length, 1);
    assert.ok(
      String(kitchen.soap.calls[0]?.values?.uri).startsWith(
        'x-sonosapi-hls:stations%7eplayable%7e%7ebbc_radio_two',
      ),
    );
    assert.ok(String(kitchen.soap.calls[0]?.values?.metadata).includes('83207bbc_radio_two'));
    await assert.rejects(bbc(context, ['play']), BadRequestError);
    await assert.rejects(bbc(context, ['stop', 'bbc_radio_two']), BadRequestError);
  });
});
