import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { PresetStore } from '../presets/store.ts';
import { createActionContext } from '../testing/action-context.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { parseSayArguments, registerAnnounceActions, textPreview } from './announce.ts';
import { ActionRegistry } from './registry.ts';

function registry() {
  const actions = new ActionRegistry();
  registerAnnounceActions(actions);
  return actions;
}

async function withPreset<T>(fn: (presets: PresetStore) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'doorbell.json'),
      '{"players":[{"roomName":"Kitchen","volume":60}],"pauseOthers":false}',
    );
    const presets = new PresetStore(dir);
    await presets.load();
    return fn(presets);
  });
}

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
    assert.deepEqual(parseSayArguments(['Hi', 'Matthew', ''], undefined), {
      phrase: 'Hi',
      voice: 'Matthew',
      volume: undefined,
    });
    assert.throws(() => parseSayArguments([], 40), BadRequestError);
    assert.throws(() => parseSayArguments(['Hi', '101'], 40), BadRequestError);
    assert.throws(() => parseSayArguments(['Hi', 'Amy', 'loud'], 40), BadRequestError);
  });
});

describe('textPreview', () => {
  it('keeps the first line, shortened to 120 characters', () => {
    assert.equal(textPreview('  Good morning.\nSecond paragraph'), 'Good morning.');
    assert.equal(textPreview('x'.repeat(130)), `${'x'.repeat(119)}…`);
    assert.equal(textPreview(''), '');
  });
});

describe('say actions', () => {
  it('say speaks the phrase on the room at the volume and answers with the result', async () => {
    const { context, announcer, spoken, player } = createActionContext();

    const result = await registry().get('say')?.(context, ['Dinner is ready', 'Matthew', '35']);

    const [spec] = announcer.calls;
    assert.deepEqual(spec?.target, { kind: 'player', player });
    assert.equal(spec?.volume, 35);
    assert.equal(spec?.source, 'say');
    assert.equal(spec?.requestId, context.requestId);
    assert.equal(spec?.textPreview, 'Dinner is ready');
    assert.deepEqual(spoken, [], 'speech is only synthesized when the announcement prepares');
    assert.deepEqual(await spec?.prepare(), {
      uri: 'http://127.0.0.1:5005/tts/Dinner%20is%20ready.mp3',
      durationMs: 1500,
      cached: undefined,
    });
    assert.deepEqual(spoken, [{ phrase: 'Dinner is ready', voice: 'Matthew' }]);
    assert.deepEqual(result, { status: 'success', announcement: announcer.result });
  });

  it('sayall announces everywhere with the default volume', async () => {
    const { context, announcer } = createActionContext({ settings: { announceVolume: 22 } });

    await registry().get('sayall')?.(context, ['Hello']);

    assert.deepEqual(announcer.calls[0]?.target, { kind: 'all' });
    assert.equal(announcer.calls[0]?.volume, 22);
    assert.equal(announcer.calls[0]?.source, 'sayall');
  });

  it('saypreset uses the preset, its volumes unless one is given, and a voice when named', async () => {
    await withPreset(async (presets) => {
      const { context, announcer } = createActionContext();
      const ctx = { ...context, presets };
      const sayPreset = registry().get('saypreset');
      assert.ok(sayPreset);

      await sayPreset(ctx, ['doorbell', 'Someone is at the door', 'Amy']);
      await sayPreset(ctx, ['doorbell', 'Someone is at the door', '50']);
      await sayPreset(ctx, ['doorbell', 'Someone is at the door', 'Amy', '50']);

      const [byPreset, atVolume, both] = announcer.calls;
      assert.equal(byPreset?.target.kind, 'preset');
      assert.equal(byPreset?.target.kind === 'preset' && byPreset.target.name, 'doorbell');
      assert.equal(byPreset?.volume, undefined, 'volumes come from the preset');
      assert.equal(atVolume?.volume, 50);
      assert.equal(both?.volume, 50);
      await assert.rejects(sayPreset(ctx, ['nope', 'x']), NotFoundError);
      await assert.rejects(sayPreset(ctx, ['doorbell']), BadRequestError);
    });
  });
});

describe('clip actions', () => {
  it('clip and clipall announce the clip url with the given or default volume', async () => {
    const { context, announcer, player } = createActionContext({
      settings: { announceVolume: 33 },
    });
    const actions = registry();

    await actions.get('clip')?.(context, ['ding dong.mp3', '50']);
    await actions.get('clipall')?.(context, ['ding dong.mp3']);

    const [room, all] = announcer.calls;
    assert.deepEqual(room?.target, { kind: 'player', player });
    assert.equal(room?.volume, 50);
    assert.equal(room?.source, 'clip');
    assert.equal(room?.textPreview, 'ding dong.mp3');
    assert.deepEqual(await room?.prepare(), {
      uri: 'http://127.0.0.1:5005/clips/ding%20dong.mp3',
      durationMs: 2500,
    });
    assert.deepEqual(all?.target, { kind: 'all' });
    assert.equal(all?.volume, 33);
    await assert.rejects(
      actions.get('clip')?.(context, []) ?? Promise.reject(new Error()),
      BadRequestError,
    );
    await assert.rejects(
      actions.get('clip')?.(context, ['a.mp3', 'x']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });

  it('clippreset plays the clip on the preset rooms, at the preset volumes unless one is given', async () => {
    await withPreset(async (presets) => {
      const { context, announcer } = createActionContext();
      const ctx = { ...context, presets };
      const clipPreset = registry().get('clippreset');
      assert.ok(clipPreset);

      await clipPreset(ctx, ['doorbell', 'ding.mp3']);
      await clipPreset(ctx, ['doorbell', 'ding.mp3', '20']);

      assert.equal(announcer.calls[0]?.target.kind, 'preset');
      assert.equal(announcer.calls[0]?.volume, undefined);
      assert.equal(announcer.calls[1]?.volume, 20);
      assert.equal(
        (await announcer.calls[0]?.prepare())?.uri,
        'http://127.0.0.1:5005/clips/ding.mp3',
      );
      await assert.rejects(clipPreset(ctx, ['nope', 'ding.mp3']), NotFoundError);
      await assert.rejects(clipPreset(ctx, ['doorbell']), BadRequestError);
    });
  });
});
