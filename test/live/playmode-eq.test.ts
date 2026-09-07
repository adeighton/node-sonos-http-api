import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { expectPlayModeRoundTrip } from '../../src/testing/contracts.ts';
import type { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

async function equalizer(harness: LiveHarness, room: string) {
  const response = await harness.action(room, 'state');
  assert.equal(response.status, 200);
  return (response.body as { equalizer: { bass: number; treble: number } }).equalizer;
}

/** Features some players lack: the API must answer either success or a UPnP refusal (502). */
function acceptedOrRefused(status: number, action: string): void {
  assert.ok(
    status === 200 || status === 502 || status === 400,
    `${action} answered ${status}; expected 200, 400 (no such hardware) or 502 (player refused)`,
  );
}

describeLive('play mode and equalizer actions (live)', ({ it }) => {
  it('repeat, shuffle and crossfade read back', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(() => expectPlayModeRoundTrip(harness, room));
  });

  it('bass and treble read back and are put back', async ({ harness }) => {
    const room = harness.rooms[0] ?? '';
    const original = await equalizer(harness, room);
    try {
      assert.equal((await harness.action(room, 'bass', '3')).status, 200);
      assert.equal((await harness.action(room, 'treble', '-2')).status, 200);
      await sleep(harness.settleMs / 2);
      const changed = await equalizer(harness, room);
      assert.equal(changed.bass, 3);
      assert.equal(changed.treble, -2);
      assert.equal((await harness.action(room, 'bass', '11')).status, 400, 'out of range');
    } finally {
      await harness.action(room, 'bass', String(original.bass));
      await harness.action(room, 'treble', String(original.treble));
    }
  });

  it('nightmode, speechenhancement and sub either work or are refused cleanly', async ({
    harness,
  }) => {
    const room = harness.rooms[0] ?? '';
    for (const [action, value] of [
      ['nightmode', 'off'],
      ['speechenhancement', 'off'],
      ['sub', 'on'],
    ] as const) {
      const response = await harness.action(room, action, value);
      acceptedOrRefused(response.status, action);
      if (response.status !== 200) {
        assert.equal((response.body as { status: string }).status, 'error');
      }
    }

    assert.equal((await harness.action(room, 'sub', 'sideways')).status, 400);
  });
});
