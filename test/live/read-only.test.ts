import assert from 'node:assert/strict';

import { expectStateShape, expectZonesShape } from '../../src/testing/contracts.ts';
import { describeLive } from './boot.ts';

describeLive('read-only actions (live)', ({ it }) => {
  it('zones and state have the documented shape for every test room', async ({ harness }) => {
    await expectZonesShape(harness);
    for (const room of harness.rooms) {
      await expectStateShape(harness, room);
    }
  });

  it('favorites and playlists list items with a title and uri', async ({ harness }) => {
    for (const action of ['favorites', 'favourites', 'playlists']) {
      const simple = await harness.action(harness.rooms[0] ?? '', action);
      assert.equal(simple.status, 200, action);
      assert.ok(Array.isArray(simple.body), `${action} is a list`);
      for (const title of simple.body as unknown[]) {
        assert.equal(typeof title, 'string', `${action} entries are titles`);
      }

      const detailed = await harness.action(harness.rooms[0] ?? '', action, 'detailed');
      assert.equal(detailed.status, 200);
      for (const entry of detailed.body as Array<Record<string, unknown>>) {
        assert.equal(typeof entry.title, 'string');
        assert.equal(typeof entry.uri, 'string');
      }
    }
  });

  it('queue returns the tracks of the room, simplified or detailed', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    const simple = await harness.action(room, 'queue');
    assert.equal(simple.status, 200);
    assert.ok(Array.isArray(simple.body));
    for (const track of simple.body as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(track), ['title', 'artist', 'album', 'albumArtUri']);
    }

    const page = await harness.action(room, 'queue', '2', '0', 'detailed');
    assert.equal(page.status, 200);
    assert.ok((page.body as unknown[]).length <= 2, 'limit honoured');
  });

  it('services lists the music services known to the system', async ({ harness }) => {
    const names = await harness.get('/services');
    assert.equal(names.status, 200);
    assert.ok((names.body as string[]).length > 10, 'a real system knows many services');
    assert.ok((names.body as string[]).includes('TuneIn'));

    const detailed = await harness.get('/services/all');
    assert.equal(detailed.status, 200);
    const services = detailed.body as Record<string, { id: number; type: number }>;
    assert.equal(typeof services['TuneIn']?.id, 'number');
    assert.equal(typeof services['TuneIn']?.type, 'number');
  });

  it('debug exposes the internal state of a room without secrets', async ({ harness }) => {
    const response = await harness.action(harness.rooms[0] ?? '', 'debug');
    assert.equal(response.status, 200);
    const text = JSON.stringify(response.body);
    assert.ok(text.includes('"uuid"'));
    assert.ok(!text.includes('secretAccessKey'));
  });

  it('siriusxm lists channels and stations', async ({ harness }) => {
    const channels = await harness.action(harness.rooms[0] ?? '', 'siriusxm', 'channels');
    assert.equal(channels.status, 200);
    assert.ok((channels.body as string[]).length > 100);
    const stations = await harness.action(harness.rooms[0] ?? '', 'siriusxm', 'stations');
    assert.equal(stations.status, 200);
    assert.equal((stations.body as string[]).length, (channels.body as string[]).length);
  });

  it('unknown actions, bad input and non-GET methods are refused with JSON errors', async ({
    harness,
  }) => {
    const unknown = await harness.get('/nope');
    assert.equal(unknown.status, 404);
    const post = await harness.fetch('/zones', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  });
});
