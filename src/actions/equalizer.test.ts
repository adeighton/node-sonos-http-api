import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerEqualizerActions } from './equalizer.ts';
import { ActionRegistry } from './registry.ts';

describe('equalizer actions', () => {
  it('sets night mode, speech enhancement, bass and treble', async () => {
    const registry = new ActionRegistry();
    registerEqualizerActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    assert.deepEqual(await registry.get('nightmode')?.(context, ['toggle']), {
      status: 'success',
      nightmode: true,
    });
    assert.deepEqual(await registry.get('speechenhancement')?.(context, ['off']), {
      status: 'success',
      speechenhancement: false,
    });
    await registry.get('bass')?.(context, ['-3']);
    await registry.get('treble')?.(context, ['4']);

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.values),
      [
        { eqType: 'NightMode', value: '1' },
        { eqType: 'DialogLevel', value: '0' },
        { level: -3 },
        { level: 4 },
      ],
    );
    await assert.rejects(
      registry.get('bass')?.(context, ['11']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });
});
