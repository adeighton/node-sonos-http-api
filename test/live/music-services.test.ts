import assert from 'node:assert/strict';

import type { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

/** Public ids from the README; only the request shape matters, the catalog may have moved on. */
const SPOTIFY_TRACK = 'spotify:track:4LI1ykYGFCcXPWkrpcU7hn';

async function serviceNames(harness: LiveHarness): Promise<string[]> {
  const response = await harness.get('/services');
  assert.equal(response.status, 200);
  return response.body as string[];
}

/** Queueing to a service the household has: 200, or 502 when the player rejects the id. */
function queuedOrRefused(status: number, action: string): void {
  assert.ok(status === 200 || status === 502, `${action}: expected 200 or 502, got ${status}`);
}

describeLive('music service actions (live)', ({ it }) => {
  it('streaming actions validate their arguments before touching a player', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    assert.equal((await harness.action(room, 'spotify', 'later', SPOTIFY_TRACK)).status, 400);
    assert.equal((await harness.action(room, 'spotify', 'queue', 'not-a-uri')).status, 400);
    assert.equal((await harness.action(room, 'applemusic', 'queue', 'video:1')).status, 400);
    assert.equal((await harness.action(room, 'amazonmusic', 'queue', 'playlist:1')).status, 400);
    assert.equal((await harness.action(room, 'napster', 'queue', 'song:')).status, 400);
    assert.equal((await harness.action(room, 'aldilifemusic', 'queue')).status, 400);
    assert.equal((await harness.action(room, 'musicsearch', 'tidal', 'song', 'x')).status, 400);
  });

  it('queues to each streaming service the household has, on a scratch room', async ({
    harness,
  }, t) => {
    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    const services = await serviceNames(harness);
    const attempts: Array<[string, string, string]> = [
      ['Spotify', 'spotify', SPOTIFY_TRACK],
      ['Apple Music', 'applemusic', 'song:355364259'],
      ['Amazon Music', 'amazonmusic', 'song:B071918VCR'],
      ['Napster', 'napster', 'song:tra.123'],
      ['ALDI life Musik', 'aldilifemusic', 'song:tra.123'],
    ];
    let exercised = 0;
    await harness.withRestore(async () => {
      for (const [service, action, id] of attempts) {
        if (!services.includes(service)) {
          t.diagnostic(`${action}: '${service}' is not on this system, skipped`);
          continue;
        }

        exercised += 1;
        queuedOrRefused((await harness.action(room, action, 'queue', id)).status, action);
      }

      await harness.action(room, 'clearqueue');
    });

    if (exercised === 0) {
      t.skip('none of the streaming services are configured on this system');
    }
  });

  it('musicsearch searches Spotify when credentials are configured', async ({ harness }, t) => {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      t.skip('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set');
      return;
    }

    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    await harness.withRestore(async () => {
      const response = await harness.action(room, 'musicsearch', 'spotify', 'station', 'Daft Punk');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      await harness.action(room, 'pause');
    });
  });

  it('musicsearch library reports whether the library is loaded', async ({ harness }, t) => {
    if (process.env.SONOS_LIVE_LIBRARY !== '1') {
      t.skip('set SONOS_LIVE_LIBRARY=1 to crawl the music library (slow)');
      return;
    }

    const room = harness.rooms[0] ?? '';
    const response = await harness.action(room, 'musicsearch', 'library', 'load');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match((response.body as { message: string }).message, /Library loaded: \d+ tracks/);
  });
});
