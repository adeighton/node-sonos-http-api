import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LibraryIndex } from '../music/library.ts';
import { MusicSearch } from '../music/search.ts';
import { createActionContext } from '../testing/action-context.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { registerMusicSearchActions } from './music-search.ts';
import { ActionRegistry } from './registry.ts';

describe('musicsearch action', () => {
  it('delegates to the search with the room, system and values', async () => {
    const registry = new ActionRegistry();
    const search = new MusicSearch({
      http: () => Promise.resolve({ body: '' }),
      fetch: fakeFetch({}).fetch,
      library: new LibraryIndex({ cacheDir: '/nonexistent' }),
    });
    const seen: string[][] = [];
    search.run = (player, system, values) => {
      seen.push([player.roomName, String(system.players.length), ...values]);
      return Promise.resolve({ ok: true });
    };
    registerMusicSearchActions(registry, search);
    const { context } = createActionContext();

    const result = await registry.get('musicsearch')?.(context, ['spotify', 'song', 'x']);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(seen, [['Kitchen', '1', 'spotify', 'song', 'x']]);
    assert.match(
      registry.list().find((entry) => entry.name === 'musicsearch')?.meta.usage ?? '',
      /musicsearch/,
    );
  });
});
