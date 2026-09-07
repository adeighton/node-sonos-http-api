import assert from 'node:assert/strict';

import { expectGroupingRoundTrip } from '../../src/testing/contracts.ts';
import { describeLive } from './boot.ts';

describeLive('grouping actions (live)', ({ it }) => {
  it('join and leave move a room between groups', async ({ harness }, t) => {
    const [member, coordinator] = harness.rooms;
    if (!member || !coordinator) {
      t.skip('needs two rooms in SONOS_LIVE_ROOMS');
      return;
    }

    await harness.withRestore(() => expectGroupingRoundTrip(harness, member, coordinator));
  });

  it('add pulls a room into this group; isolate and ungroup take it out', async ({
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
      assert.ok(roomA && roomB, 'both rooms are in the topology');
      if (roomA.coordinator !== roomA.uuid || roomB.coordinator !== roomB.uuid) {
        t.skip('both rooms must coordinate their own group (standalone or leading a group)');
        return;
      }

      // B leaves whatever group it was in and joins A's group (A keeps its other members).
      const grouped = [...new Set([...roomA.members, roomB.uuid])].sort();
      assert.equal((await harness.action(a, 'add', b)).status, 200);
      // A member reports its coordinator's transport, play mode and playback state.
      await harness.assertRestored({
        [a]: { ...roomA, members: grouped },
        [b]: {
          ...roomA,
          uuid: roomB.uuid,
          volume: roomB.volume,
          mute: roomB.mute,
          coordinator: roomA.uuid,
          members: grouped,
        },
      });

      // isolate and ungroup both make B standalone again.
      const standalone = { ...roomB, coordinator: roomB.uuid, members: [roomB.uuid] };
      assert.equal((await harness.action(b, 'isolate')).status, 200);
      await harness.assertRestored({ [b]: standalone });

      assert.equal((await harness.action(b, 'join', a)).status, 200);
      assert.equal((await harness.action(b, 'ungroup')).status, 200);
      await harness.assertRestored({ [b]: standalone });
    });
  });
});
