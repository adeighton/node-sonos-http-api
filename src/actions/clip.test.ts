import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { PresetStore } from '../presets/store.ts';
import { createActionContext } from '../testing/action-context.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { registerClipActions } from './clip.ts';
import { ActionRegistry } from './registry.ts';

describe('clip actions', () => {
  it('clip and clipall announce the clip url with the given or default volume', async () => {
    const registry = new ActionRegistry();
    registerClipActions(registry);
    const { context, announcer, player } = createActionContext({
      settings: { announceVolume: 33 },
    });

    await registry.get('clip')?.(context, ['ding dong.mp3', '50']);
    await registry.get('clipall')?.(context, ['ding dong.mp3']);

    assert.deepEqual(announcer.calls[0]?.target, { kind: 'player', player });
    assert.deepEqual(announcer.calls[0]?.announcement, {
      uri: 'http://127.0.0.1:5005/clips/ding%20dong.mp3',
      durationMs: 2500,
      volume: 50,
    });
    assert.deepEqual(announcer.calls[1]?.target, { kind: 'all' });
    assert.equal(announcer.calls[1]?.announcement.volume, 33);
    await assert.rejects(
      registry.get('clip')?.(context, []) ?? Promise.reject(new Error()),
      BadRequestError,
    );
    await assert.rejects(
      registry.get('clip')?.(context, ['a.mp3', 'x']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });

  it('clippreset plays the clip on the preset rooms', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'doorbell.json'),
        '{"players":[{"roomName":"Kitchen","volume":60}]}',
      );
      const registry = new ActionRegistry();
      registerClipActions(registry);
      const { context, announcer } = createActionContext();
      const presets = new PresetStore(dir);
      await presets.load();
      const ctx = { ...context, presets };
      const clipPreset = registry.get('clippreset');
      assert.ok(clipPreset);

      await clipPreset(ctx, ['doorbell', 'ding.mp3']);

      assert.equal(announcer.calls[0]?.target.kind, 'preset');
      assert.equal(announcer.calls[0]?.announcement.uri, 'http://127.0.0.1:5005/clips/ding.mp3');
      await assert.rejects(clipPreset(ctx, ['nope', 'ding.mp3']), NotFoundError);
      await assert.rejects(clipPreset(ctx, ['doorbell']), BadRequestError);
    });
  });
});
