import assert from 'node:assert/strict';

import { describeLive } from './boot.ts';

describeLive('preset action (live)', ({ it }) => {
  it('lists the presets from the presets folder', async ({ harness }) => {
    const response = await harness.get('/preset');
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body));
    assert.ok((response.body as string[]).length > 0, 'the repo ships presets');
    assert.equal((await harness.get('/preset/no-such-preset')).status, 404);
  });

  it('applies an inline preset over the test rooms and the rooms are restored', async ({
    harness,
  }, t) => {
    const [a, b] = harness.rooms;
    if (!a || !b) {
      t.skip('needs two rooms in SONOS_LIVE_ROOMS');
      return;
    }

    await harness.withRestore(async (before) => {
      const roomA = before[a];
      const roomB = before[b];
      assert.ok(roomA && roomB);
      const preset = {
        players: [
          { roomName: a, volume: 11 },
          { roomName: b, volume: 12 },
        ],
        pauseOthers: false,
        state: 'STOPPED',
      };
      const applied = await harness.get(`/preset/${encodeURIComponent(JSON.stringify(preset))}`);
      assert.equal(applied.status, 200, JSON.stringify(applied.body));

      // A member reports its coordinator's transport, play mode and playback state.
      const grouped = [roomA.uuid, roomB.uuid].sort();
      await harness.assertRestored({
        [a]: { ...roomA, volume: 11, members: grouped },
        [b]: {
          ...roomA,
          uuid: roomB.uuid,
          mute: roomB.mute,
          volume: 12,
          coordinator: roomA.uuid,
          members: grouped,
        },
      });

      assert.equal((await harness.get('/preset/%7Bnot-json')).status, 400);
    });
  });
});
