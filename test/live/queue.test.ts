import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { describeLive } from './boot.ts';

describeLive('queue and system actions (live)', ({ it }) => {
  it('setavtransporturi and clearqueue work on a scratch room', async ({ harness }, t) => {
    const room = await harness.scratchRoom();
    if (!room) {
      t.skip('no test room has an empty queue');
      return;
    }

    await harness.withRestore(async (before) => {
      const uuid = before[room]?.uuid ?? '';
      // Pointing the room at its own (empty) queue is harmless and always accepted.
      const set = await harness.action(room, 'setavtransporturi', `x-rincon-queue:${uuid}#0`);
      assert.equal(set.status, 200);
      await sleep(harness.settleMs / 4);

      assert.equal((await harness.action(room, 'clearqueue')).status, 200);
      const queue = await harness.action(room, 'queue');
      assert.equal(queue.status, 200);
      assert.deepEqual(queue.body, []);

      assert.equal((await harness.action(room, 'setavtransporturi')).status, 400);
    });
  });

  it('reindex asks the system to refresh the music library index', async ({ harness }) => {
    const response = await harness.get('/reindex');
    // A refresh already in progress is refused by the player; both are valid answers.
    assert.ok(response.status === 200 || response.status === 502, `reindex: ${response.status}`);
  });
});
