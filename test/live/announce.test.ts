import assert from 'node:assert/strict';

import type { AnnouncementResult } from '../../src/announce/types.ts';
import { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

const CLIP = 'TacoBellBong.mp3';
const VOLUME = '15';
/** A preset from the presets folder whose rooms may make noise; override for other households. */
const PRESET = process.env.SONOS_LIVE_PRESET ?? 'firstfloor';

async function everyRoom(harness: LiveHarness): Promise<string[]> {
  return (await harness.zones()).flatMap((zone) => zone.members.map((m) => m.roomName));
}

/** Rooms playing their TV input right now; an "every room" announcement must leave them alone. */
async function watchingTv(harness: LiveHarness): Promise<string[]> {
  return (await harness.zones()).flatMap((zone) =>
    zone.members
      .filter(
        (m) =>
          m.state.currentTrack.uri.startsWith('x-sonos-htastream:') &&
          m.state.playbackState === 'PLAYING',
      )
      .map((m) => m.roomName),
  );
}

function ttsConfigured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID);
}

/** The structured result every announcement action answers with, checked for shape. */
function announced(body: unknown, rooms?: string[]): AnnouncementResult {
  const { status, announcement } = body as { status: string; announcement?: AnnouncementResult };
  assert.equal(status, 'success');
  assert.ok(announcement, JSON.stringify(body));
  assert.equal(announcement.state, 'done');
  assert.equal(announcement.restore, 'ok', announcement.warnings.join('; '));
  assert.ok((announcement.clip?.durationMs ?? 0) > 0, 'the clip has a length');
  assert.equal(typeof announcement.timings.totalMs, 'number');
  if (rooms) {
    assert.deepEqual([...announcement.rooms].sort(), [...rooms].sort());
  }
  return announcement;
}

describeLive('announcement actions (live)', ({ it }) => {
  it('say speaks in one room and restores it', async ({ harness }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const response = await harness.action(room, 'say', 'Live test, one room', VOLUME);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const result = announced(response.body, [room]);
      assert.equal(result.source, 'say');
      assert.equal(response.headers.get('X-Request-Id')?.length, 36, 'a request id is echoed');
      await harness.assertRestored(before);
    });
  });

  it('say validates its arguments', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    assert.equal((await harness.action(room, 'say')).status, 400);
    if (ttsConfigured()) {
      assert.equal((await harness.action(room, 'say', 'hello', 'Gandalf', VOLUME)).status, 400);
    }
  });

  it('clip plays a file from static/clips in one room and restores it', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const response = await harness.action(room, 'clip', CLIP, VOLUME);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      announced(response.body, [room]);
      await harness.assertRestored(before);
    });

    assert.equal((await harness.action(room, 'clip', 'no-such-clip.mp3')).status, 404);
    assert.equal((await harness.action(room, 'clip', '../secret.mp3')).status, 400);
  });

  it('clipall and sayall reach every room but one watching TV, and restore the whole house', async ({
    harness,
  }, t) => {
    const rooms = await everyRoom(harness);
    const tvRooms = await watchingTv(harness);
    if (tvRooms.length === 0) {
      t.diagnostic('no room is playing TV audio; the TV rule is not exercised in this run');
    }
    const tvBefore = await harness.snapshot(tvRooms);
    const expected = rooms.filter((room) => !tvRooms.includes(room));
    await harness.withRestore(async (before) => {
      const clip = await harness.get(`/clipall/${CLIP}/${VOLUME}`);
      assert.equal(clip.status, 200, JSON.stringify(clip.body));
      announced(clip.body, expected);
      await harness.assertRestored(before);
      // Transport and playback state included: the film was neither joined nor stopped.
      assert.deepEqual(LiveHarness.differences(tvBefore, await harness.snapshot(tvRooms)), []);

      if (!ttsConfigured()) {
        t.diagnostic('sayall skipped: AWS credentials are not configured');
        return;
      }

      const say = await harness.get(
        `/sayall/${encodeURIComponent('Live test, all rooms')}/${VOLUME}`,
      );
      assert.equal(say.status, 200, JSON.stringify(say.body));
      announced(say.body, expected);
      await harness.assertRestored(before);
      assert.deepEqual(LiveHarness.differences(tvBefore, await harness.snapshot(tvRooms)), []);
    }, rooms);
  });

  it('clippreset and saypreset use the rooms of a preset and restore them', async ({
    harness,
  }, t) => {
    const presets = (await harness.get('/preset')).body as string[];
    if (!presets.includes(PRESET)) {
      t.skip(`preset '${PRESET}' is not in the presets folder (set SONOS_LIVE_PRESET)`);
      return;
    }

    const rooms = await everyRoom(harness);
    // The whole house is snapshotted: rooms outside the preset must come through untouched.
    await harness.withRestore(async (before) => {
      const clip = await harness.get(`/clippreset/${PRESET}/${CLIP}/${VOLUME}`);
      assert.equal(clip.status, 200, JSON.stringify(clip.body));
      const played = announced(clip.body);
      assert.ok(played.rooms.length > 0 && played.rooms.length < rooms.length, 'a subset of rooms');
      await harness.assertRestored(before);

      if (!ttsConfigured()) {
        t.diagnostic('saypreset skipped: AWS credentials are not configured');
        return;
      }

      const say = await harness.get(
        `/saypreset/${PRESET}/${encodeURIComponent('Live test, preset rooms')}`,
      );
      assert.equal(say.status, 200, JSON.stringify(say.body));
      announced(say.body, played.rooms);
      await harness.assertRestored(before);
    }, rooms);

    assert.equal((await harness.get(`/clippreset/no-such-preset/${CLIP}`)).status, 404);
  });
});
