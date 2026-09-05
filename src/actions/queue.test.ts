import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { fixturePath } from '../testing/fixtures.ts';
import { registerQueueActions } from './queue.ts';
import { ActionRegistry } from './registry.ts';

describe('queue actions', () => {
  it('returns the simplified or detailed queue with limit and offset', async () => {
    const registry = new ActionRegistry();
    registerQueueActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const queue = registry.get('queue');
    assert.ok(queue);

    kitchen.soap.queueResponse(createReadStream(fixturePath('queue.xml')));
    const simple = (await queue(context, [])) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(simple[0] ?? {}), ['title', 'artist', 'album', 'albumArtUri']);
    assert.deepEqual(kitchen.soap.calls[0]?.values, { objectId: 'Q:0', startIndex: 0, limit: 0 });

    kitchen.soap.queueResponse(createReadStream(fixturePath('queue.xml')));
    const detailed = (await queue(context, ['10', '5', 'detailed'])) as Array<
      Record<string, unknown>
    >;
    assert.ok('uri' in (detailed[0] ?? {}));
    assert.deepEqual(kitchen.soap.calls[1]?.values, { objectId: 'Q:0', startIndex: 5, limit: 10 });
  });

  it('clears the queue and sets an arbitrary transport uri', async () => {
    const registry = new ActionRegistry();
    registerQueueActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    await registry.get('clearqueue')?.(context, []);
    await registry.get('setavtransporturi')?.(context, ['x-rincon-mp3radio://host/stream']);

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.RemoveAllTracksFromQueue, SOAP_ACTIONS.SetAVTransportURI],
    );
    assert.equal(kitchen.player.avTransportUri, 'x-rincon-mp3radio://host/stream');
    await assert.rejects(
      registry.get('setavtransporturi')?.(context, []) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });
});
