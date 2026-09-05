import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { parseRepeatMode, registerPlayModeActions } from './playmode.ts';
import { ActionRegistry } from './registry.ts';

describe('parseRepeatMode', () => {
  it('normalizes on/off and cycles toggle', () => {
    assert.equal(parseRepeatMode('on', 'none'), 'all');
    assert.equal(parseRepeatMode('off', 'all'), 'none');
    assert.equal(parseRepeatMode('one', 'none'), 'one');
    assert.equal(parseRepeatMode('toggle', 'none'), 'all');
    assert.equal(parseRepeatMode('toggle', 'all'), 'one');
    assert.equal(parseRepeatMode('toggle', 'one'), 'none');
    assert.throws(() => parseRepeatMode('twice', 'none'), BadRequestError);
  });
});

describe('play mode actions', () => {
  it('sets repeat, shuffle and crossfade and answers with the new state', async () => {
    const registry = new ActionRegistry();
    registerPlayModeActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    assert.deepEqual(await registry.get('repeat')?.(context, ['on']), {
      status: 'success',
      repeat: 'all',
    });
    assert.deepEqual(await registry.get('shuffle')?.(context, ['toggle']), {
      status: 'success',
      shuffle: true,
    });
    assert.deepEqual(await registry.get('crossfade')?.(context, ['off']), {
      status: 'success',
      crossfade: false,
    });

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.values),
      [{ playMode: 'REPEAT_ALL' }, { playMode: 'SHUFFLE_NOREPEAT' }, { crossfadeMode: 0 }],
    );
    await assert.rejects(
      registry.get('shuffle')?.(context, ['sometimes']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });
});
