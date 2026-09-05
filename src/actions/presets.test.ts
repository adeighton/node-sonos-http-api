import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { PresetStore } from '../presets/store.ts';
import { createActionContext } from '../testing/action-context.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { registerPresetActions } from './presets.ts';
import { ActionRegistry } from './registry.ts';

describe('preset action', () => {
  it('lists, applies by name and applies inline JSON', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'library.json'),
        '{ players: [{ roomName: "Library", volume: 20 }] }',
      );
      const registry = new ActionRegistry();
      registerPresetActions(registry);
      const { context, system } = createActionContext({ presetDir: dir });
      const presets = new PresetStore(dir);
      await presets.load();
      const ctx = { ...context, presets };
      const action = registry.get('preset');
      assert.ok(action);

      assert.deepEqual(await action(ctx, []), ['library']);

      await action(ctx, ['library']);
      assert.deepEqual(system.appliedPresets[0]?.players, [{ roomName: 'Library', volume: 20 }]);

      await action(ctx, ['{"players":[{"roomName":"Kitchen","volume":5}],"pauseOthers":true}']);
      assert.equal(system.appliedPresets[1]?.pauseOthers, true);

      await assert.rejects(action(ctx, ['nope']), (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.match(error.message, /Available presets: library/);
        return true;
      });
      await assert.rejects(action(ctx, ['{not json']), BadRequestError);
      await assert.rejects(action(ctx, ['{"players":[]}']), (error: unknown) => {
        assert.ok(error instanceof BadRequestError);
        assert.match(error.message, /inline preset/);
        return true;
      });
    });
  });
});
