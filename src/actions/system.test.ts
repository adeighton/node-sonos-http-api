import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { registerSystemActions } from './system.ts';

describe('system actions', () => {
  it('reindexes, lists services and dumps debug information', async () => {
    const registry = new ActionRegistry();
    registerSystemActions(registry);
    const { context, system } = createActionContext();
    system.availableServices = {
      Spotify: { id: 9, capabilities: 1, type: 2311 },
      Deezer: { id: 2, capabilities: 1, type: 519 },
    };

    await registry.get('reindex')?.(context, []);
    assert.equal(system.refreshShareIndex.mock.callCount(), 1);

    assert.deepEqual(await registry.get('services')?.(context, []), ['Deezer', 'Spotify']);
    assert.equal(
      ((await registry.get('services')?.(context, ['all'])) as Record<string, unknown>).Spotify,
      system.availableServices.Spotify,
    );

    const debug = (await registry.get('debug')?.(context, [])) as {
      version: string;
      system: { localEndpoint: string };
      players: Array<{ roomName: string; state: { volume: number }; baseUrl: string }>;
    };
    assert.equal(debug.version, '0.0.0-test');
    assert.equal(debug.system.localEndpoint, '127.0.0.1');
    assert.equal(debug.players[0]?.roomName, 'Kitchen');
    assert.equal(debug.players[0]?.state.volume, 0);
    assert.equal(debug.players[0]?.baseUrl, 'http://192.168.1.151:1400');
  });
});
