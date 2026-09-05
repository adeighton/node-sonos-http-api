import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { PresetStore } from '../presets/store.ts';
import { createActionContext } from '../testing/action-context.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { ActionRegistry } from './registry.ts';
import { parseSayArguments, registerSayActions } from './say.ts';

describe('parseSayArguments', () => {
  it('reads phrase, optional voice and optional volume', () => {
    assert.deepEqual(parseSayArguments(['Hi'], 40), { phrase: 'Hi', voice: undefined, volume: 40 });
    assert.deepEqual(parseSayArguments(['Hi', '25'], 40), {
      phrase: 'Hi',
      voice: undefined,
      volume: 25,
    });
    assert.deepEqual(parseSayArguments(['Hi', 'Matthew'], 40), {
      phrase: 'Hi',
      voice: 'Matthew',
      volume: 40,
    });
    assert.deepEqual(parseSayArguments(['Hi', 'Matthew', '30'], 40), {
      phrase: 'Hi',
      voice: 'Matthew',
      volume: 30,
    });
    assert.throws(() => parseSayArguments([], 40), BadRequestError);
    assert.throws(() => parseSayArguments(['Hi', '101'], 40), BadRequestError);
    assert.throws(() => parseSayArguments(['Hi', 'Amy', 'loud'], 40), BadRequestError);
  });
});

describe('say actions', () => {
  it('say speaks the phrase and announces it on the room with the volume', async () => {
    const registry = new ActionRegistry();
    registerSayActions(registry);
    const { context, announcer, spoken, player } = createActionContext();

    await registry.get('say')?.(context, ['Dinner is ready', 'Matthew', '35']);

    assert.deepEqual(spoken, [{ phrase: 'Dinner is ready', voice: 'Matthew' }]);
    assert.equal(announcer.calls.length, 1);
    assert.deepEqual(announcer.calls[0]?.target, { kind: 'player', player });
    assert.deepEqual(announcer.calls[0]?.announcement, {
      uri: 'http://127.0.0.1:5005/tts/Dinner%20is%20ready.mp3',
      durationMs: 1500,
      volume: 35,
    });
  });

  it('sayall announces everywhere with the default volume', async () => {
    const registry = new ActionRegistry();
    registerSayActions(registry);
    const { context, announcer } = createActionContext({ settings: { announceVolume: 22 } });

    await registry.get('sayall')?.(context, ['Hello']);

    assert.deepEqual(announcer.calls[0]?.target, { kind: 'all' });
    assert.equal(announcer.calls[0]?.announcement.volume, 22);
  });

  it('saypreset uses the preset and rejects volumes in the voice position', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'doorbell.json'),
        '{"players":[{"roomName":"Kitchen","volume":60}]}',
      );
      const registry = new ActionRegistry();
      registerSayActions(registry);
      const { context, announcer } = createActionContext();
      const presets = new PresetStore(dir);
      await presets.load();
      const ctx = { ...context, presets };
      const sayPreset = registry.get('saypreset');
      assert.ok(sayPreset);

      await sayPreset(ctx, ['doorbell', 'Someone is at the door', 'Amy']);

      assert.equal(announcer.calls[0]?.target.kind, 'preset');
      assert.equal(
        announcer.calls[0]?.announcement.volume,
        undefined,
        'volumes come from the preset',
      );
      await assert.rejects(sayPreset(ctx, ['nope', 'x']), NotFoundError);
      await assert.rejects(sayPreset(ctx, ['doorbell']), BadRequestError);
      await assert.rejects(sayPreset(ctx, ['doorbell', 'x', '50']), BadRequestError);
    });
  });
});
