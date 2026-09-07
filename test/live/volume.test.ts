import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { expectMuteRoundTrip, expectVolumeRoundTrip } from '../../src/testing/contracts.ts';
import type { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

async function stateOf(harness: LiveHarness, room: string) {
  const response = await harness.action(room, 'state');
  assert.equal(response.status, 200);
  return response.body as { volume: number; mute: boolean };
}

describeLive('volume and mute actions (live)', ({ it }) => {
  it('volume: absolute and relative changes read back', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(() => expectVolumeRoundTrip(harness, room));
  });

  it('mute / unmute / togglemute read back', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async () => {
      await expectMuteRoundTrip(harness, room);

      const before = (await stateOf(harness, room)).mute;
      assert.equal((await harness.action(room, 'togglemute')).status, 200);
      await sleep(harness.settleMs / 4);
      assert.equal((await stateOf(harness, room)).mute, !before, 'togglemute flips');
      assert.equal((await harness.action(room, 'togglemute')).status, 200);
    });
  });

  it('groupvolume, groupmute and their aliases act on the group', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const original = before[room]?.volume ?? 0;
      const target = original === 12 ? 18 : 12;
      assert.equal((await harness.action(room, 'groupvolume', String(target))).status, 200);
      await sleep(harness.settleMs / 4);
      assert.equal((await stateOf(harness, room)).volume, target);

      for (const [action, expected] of [
        ['groupmute', true],
        ['groupunmute', false],
        ['mutegroup', true],
        ['unmutegroup', false],
      ] as const) {
        assert.equal((await harness.action(room, action)).status, 200, action);
        await sleep(harness.settleMs / 4);
        assert.equal((await stateOf(harness, room)).mute, expected, action);
      }
    });
  });

  it('lockvolumes reverts a volume change until unlockvolumes', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const locked = before[room]?.volume ?? 0;
      assert.equal((await harness.get('/lockvolumes')).status, 200);
      try {
        assert.equal((await harness.action(room, 'volume', String(locked + 7))).status, 200);
        // The lock reacts to the player's volume event, so the revert is asynchronous.
        const deadline = Date.now() + harness.settleMs;
        let volume = locked + 7;
        while (Date.now() < deadline && volume !== locked) {
          await sleep(250);
          volume = (await stateOf(harness, room)).volume;
        }
        assert.equal(volume, locked, 'volume snapped back to the locked value');
      } finally {
        assert.equal((await harness.get('/unlockvolumes')).status, 200);
      }

      assert.equal((await harness.action(room, 'volume', String(locked + 3))).status, 200);
      await sleep(harness.settleMs / 2);
      assert.equal((await stateOf(harness, room)).volume, locked + 3, 'unlocked again');
    });
  });
});
