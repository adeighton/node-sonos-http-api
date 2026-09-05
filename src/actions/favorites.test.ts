import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerFavoriteActions } from './favorites.ts';
import { registerPlaylistActions } from './playlists.ts';
import { ActionRegistry } from './registry.ts';

const radio = { title: 'Radio', uri: 'x-sonosapi-stream:s1?sid=254', metadata: '<m/>' };

describe('favorites and playlists actions', () => {
  it('lists favorites (titles or detailed) with both spellings and plays one', async () => {
    const registry = new ActionRegistry();
    registerFavoriteActions(registry);
    const { context, rooms, system } = createActionContext();
    system.favorites = [radio];
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    assert.deepEqual(await registry.get('favourites')?.(context, []), ['Radio']);
    assert.deepEqual(await registry.get('favorites')?.(context, ['detailed']), [radio]);

    await registry.get('favourite')?.(context, ['radio']);
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.SetAVTransportURI, SOAP_ACTIONS.Play],
    );
    await assert.rejects(
      registry.get('favorite')?.(context, []) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });

  it('lists playlists and plays one through the queue', async () => {
    const registry = new ActionRegistry();
    registerPlaylistActions(registry);
    const { context, rooms, system } = createActionContext();
    system.playlists = [{ title: 'Morning', uri: 'file:///jffs/settings/savedqueues.rsq#2' }];
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    assert.deepEqual(await registry.get('playlists')?.(context, []), ['Morning']);
    assert.equal(
      ((await registry.get('playlists')?.(context, ['detailed'])) as unknown[]).length,
      1,
    );

    await registry.get('playlist')?.(context, ['morning']);
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [
        SOAP_ACTIONS.RemoveAllTracksFromQueue,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.Play,
      ],
    );
  });
});
