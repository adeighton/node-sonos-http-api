import assert from 'node:assert/strict';

import type { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

const CLIP = 'TacoBellBong.mp3';
const VOLUME = '15';
/** A preset from the presets folder whose rooms may make noise; override for other households. */
const PRESET = process.env.SONOS_LIVE_PRESET ?? 'firstfloor';

async function everyRoom(harness: LiveHarness): Promise<string[]> {
  return (await harness.zones()).flatMap((zone) => zone.members.map((m) => m.roomName));
}

function ttsConfigured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID);
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
      assert.equal((response.body as { status: string }).status, 'success');
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
      await harness.assertRestored(before);
    });

    assert.equal((await harness.action(room, 'clip', 'no-such-clip.mp3')).status, 404);
    assert.equal((await harness.action(room, 'clip', '../secret.mp3')).status, 400);
  });

  it('clipall and sayall reach every room and restore the whole house', async ({ harness }, t) => {
    const rooms = await everyRoom(harness);
    await harness.withRestore(async (before) => {
      const clip = await harness.get(`/clipall/${CLIP}/${VOLUME}`);
      assert.equal(clip.status, 200, JSON.stringify(clip.body));
      await harness.assertRestored(before);

      if (!ttsConfigured()) {
        t.diagnostic('sayall skipped: AWS credentials are not configured');
        return;
      }

      const say = await harness.get(
        `/sayall/${encodeURIComponent('Live test, all rooms')}/${VOLUME}`,
      );
      assert.equal(say.status, 200, JSON.stringify(say.body));
      await harness.assertRestored(before);
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
    await harness.withRestore(async (before) => {
      const clip = await harness.get(`/clippreset/${PRESET}/${CLIP}`);
      assert.equal(clip.status, 200, JSON.stringify(clip.body));
      await harness.assertRestored(before);

      if (!ttsConfigured()) {
        t.diagnostic('saypreset skipped: AWS credentials are not configured');
        return;
      }

      const say = await harness.get(
        `/saypreset/${PRESET}/${encodeURIComponent('Live test, preset rooms')}`,
      );
      assert.equal(say.status, 200, JSON.stringify(say.body));
      await harness.assertRestored(before);
    }, rooms);

    assert.equal((await harness.get(`/clippreset/no-such-preset/${CLIP}`)).status, 404);
  });
});
