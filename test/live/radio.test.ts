import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import type { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

/** BBC Radio 6 Music on TuneIn (README example); any valid station id works. */
const TUNEIN_STATION = '44491';
const BBC_STATION = 'bbc_radio_two';

async function transport(harness: LiveHarness, room: string) {
  const response = await harness.action(room, 'state');
  assert.equal(response.status, 200);
  const state = response.body as { playbackState: string; currentTrack: { uri: string } };
  return { playbackState: state.playbackState, uri: state.currentTrack.uri };
}

async function untilUri(harness: LiveHarness, room: string, prefix: string): Promise<string> {
  const deadline = Date.now() + harness.settleMs;
  let current = await transport(harness, room);
  while (!current.uri.startsWith(prefix) && Date.now() < deadline) {
    await sleep(250);
    current = await transport(harness, room);
  }

  return current.uri;
}

describeLive('radio and line-in actions (live)', ({ it }) => {
  it('tunein set/play selects and starts a station', async ({ harness }, t) => {
    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    await harness.withRestore(async () => {
      assert.equal((await harness.action(room, 'tunein', 'set', TUNEIN_STATION)).status, 200);
      // Current players rewrite the legacy TuneIn uri to their own service id and station key,
      // so only the stream prefix is stable.
      assert.match(await untilUri(harness, room, 'x-sonosapi-stream:'), /^x-sonosapi-stream:/);

      assert.equal((await harness.action(room, 'tunein', 'play', TUNEIN_STATION)).status, 200);
      await sleep(harness.settleMs / 2);
      assert.ok(
        ['PLAYING', 'TRANSITIONING'].includes((await transport(harness, room)).playbackState),
        'station is playing',
      );
      assert.equal((await harness.action(room, 'pause')).status, 200);
      assert.equal((await harness.action(room, 'tunein', 'skip', TUNEIN_STATION)).status, 400);
    });
  });

  it('bbcsounds set selects a station', async ({ harness }, t) => {
    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    await harness.withRestore(async () => {
      const response = await harness.action(room, 'bbcsounds', 'set', BBC_STATION);
      // Players outside the UK may refuse the service; the API must still answer cleanly.
      assert.ok(
        response.status === 200 || response.status === 502,
        `bbcsounds: ${response.status}`,
      );
      if (response.status === 200) {
        assert.match(await untilUri(harness, room, 'x-sonosapi-hls:'), /^x-sonosapi-hls:/);
      }

      assert.equal((await harness.action(room, 'bbcsounds', 'play')).status, 400);
    });
  });

  it('linein plays the analog input or is refused by players without one', async ({
    harness,
  }, t) => {
    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    await harness.withRestore(async () => {
      const response = await harness.action(room, 'linein');
      assert.ok(response.status === 200 || response.status === 502, `linein: ${response.status}`);
      if (response.status === 200) {
        assert.match(await untilUri(harness, room, 'x-rincon-stream:'), /^x-rincon-stream:/);
        await harness.action(room, 'pause');
      }

      assert.equal((await harness.action(room, 'linein', 'No Such Room')).status, 404);
    });
  });
});
