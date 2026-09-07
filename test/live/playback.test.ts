import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import type { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

interface State {
  playbackState: string;
  trackNo: number;
  elapsedTime: number;
  currentTrack: { uri: string };
}

async function stateOf(harness: LiveHarness, room: string): Promise<State> {
  const response = await harness.action(room, 'state');
  assert.equal(response.status, 200);
  return response.body as State;
}

async function queueLength(harness: LiveHarness, room: string): Promise<number> {
  const response = await harness.action(room, 'queue');
  assert.equal(response.status, 200);
  return (response.body as unknown[]).length;
}

/** The first test room that has tracks queued and is playing from its queue. */
async function roomWithQueue(harness: LiveHarness): Promise<string | undefined> {
  for (const room of harness.rooms) {
    const state = await stateOf(harness, room);
    if ((await queueLength(harness, room)) >= 2 && !state.currentTrack.uri.startsWith('x-rincon')) {
      return room;
    }
  }

  return undefined;
}

async function until(
  harness: LiveHarness,
  room: string,
  check: (state: State) => boolean,
): Promise<State> {
  const deadline = Date.now() + harness.settleMs;
  let state = await stateOf(harness, room);
  while (!check(state) && Date.now() < deadline) {
    await sleep(250);
    state = await stateOf(harness, room);
  }

  return state;
}

describeLive('playback actions (live)', ({ it }) => {
  it('play, pause and playpause change the playback state', async ({ harness }, t) => {
    const room = await roomWithQueue(harness);
    if (!room) {
      t.skip('no test room has a queue with two or more tracks');
      return;
    }

    await harness.withRestore(async () => {
      assert.equal((await harness.action(room, 'play')).status, 200);
      assert.ok(
        ['PLAYING', 'TRANSITIONING'].includes(
          (await until(harness, room, (s) => s.playbackState === 'PLAYING')).playbackState,
        ),
      );

      assert.equal((await harness.action(room, 'pause')).status, 200);
      assert.equal(
        (await until(harness, room, (s) => s.playbackState === 'PAUSED_PLAYBACK')).playbackState,
        'PAUSED_PLAYBACK',
      );

      const toggled = await harness.action(room, 'playpause');
      assert.equal(toggled.status, 200);
      assert.deepEqual(toggled.body, { status: 'success', paused: false });
      assert.equal(
        (await until(harness, room, (s) => s.playbackState === 'PLAYING')).playbackState,
        'PLAYING',
      );
      assert.equal((await harness.action(room, 'playpause')).status, 200);
    });
  });

  it('next, previous, trackseek, timeseek and seek move within the queue', async ({
    harness,
  }, t) => {
    const room = await roomWithQueue(harness);
    if (!room) {
      t.skip('no test room has a queue with two or more tracks');
      return;
    }

    await harness.withRestore(async () => {
      const start = await stateOf(harness, room);
      assert.equal((await harness.action(room, 'trackseek', '1')).status, 200);
      await until(harness, room, (s) => s.trackNo === 1);
      assert.equal((await harness.action(room, 'next')).status, 200);
      assert.equal((await until(harness, room, (s) => s.trackNo === 2)).trackNo, 2);
      assert.equal((await harness.action(room, 'previous')).status, 200);
      assert.equal((await until(harness, room, (s) => s.trackNo === 1)).trackNo, 1);

      assert.equal((await harness.action(room, 'timeseek', '5')).status, 200);
      assert.equal((await harness.action(room, 'seek', '3')).status, 200);
      assert.equal((await harness.action(room, 'timeseek', 'soon')).status, 400);
      assert.equal((await harness.action(room, 'trackseek', '0')).status, 400);

      assert.equal(
        (await harness.action(room, 'trackseek', String(start.trackNo || 1))).status,
        200,
      );
    });
  });

  it('sleep sets and clears the sleep timer', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    assert.equal((await harness.action(room, 'sleep', '60')).status, 200);
    assert.equal((await harness.action(room, 'sleep', 'off')).status, 200);
    assert.equal((await harness.action(room, 'sleep', 'later')).status, 400);
  });

  it('pauseall pauses what is playing and resumeall restarts it', async ({ harness }, t) => {
    const room = await roomWithQueue(harness);
    if (!room) {
      t.skip('no test room has a queue to play from');
      return;
    }

    // Everything in the house may be paused briefly; snapshot every room so it is put back.
    const everyRoom = (await harness.zones()).flatMap((zone) =>
      zone.members.map((m) => m.roomName),
    );
    await harness.withRestore(async () => {
      assert.equal((await harness.action(room, 'play')).status, 200);
      await until(harness, room, (s) => s.playbackState === 'PLAYING');

      assert.equal((await harness.get('/pauseall')).status, 200);
      assert.equal(
        (await until(harness, room, (s) => s.playbackState === 'PAUSED_PLAYBACK')).playbackState,
        'PAUSED_PLAYBACK',
      );

      assert.equal((await harness.get('/resumeall')).status, 200);
      assert.equal(
        (await until(harness, room, (s) => s.playbackState === 'PLAYING')).playbackState,
        'PLAYING',
      );
      assert.equal((await harness.action(room, 'pause')).status, 200);
    }, everyRoom);
  });

  it('favorite and playlist replace the queue of a scratch room', async ({ harness }, t) => {
    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    const favorites = (await harness.get('/favorites')).body as string[];
    const playlists = (await harness.get('/playlists')).body as string[];
    await harness.withRestore(async () => {
      if (favorites[0]) {
        for (const action of ['favorite', 'favourite']) {
          const response = await harness.action(room, action, favorites[0]);
          assert.ok(
            response.status === 200 || response.status === 502,
            `${action}: ${response.status}`,
          );
        }
      }

      if (playlists[0]) {
        const response = await harness.action(room, 'playlist', playlists[0]);
        assert.ok(
          response.status === 200 || response.status === 502,
          `playlist: ${response.status}`,
        );
      }

      assert.equal((await harness.action(room, 'favorite', 'no such favorite ever')).status, 404);
      assert.equal((await harness.action(room, 'playlist', 'no such playlist ever')).status, 404);
      await harness.action(room, 'pause');
      await harness.action(room, 'clearqueue');
    });
  });
});
