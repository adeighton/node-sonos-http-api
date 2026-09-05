import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { registerSeekActions } from './seek.ts';

describe('seek actions', () => {
  it('seeks by time (with the deprecated alias) and by track, validating input', async () => {
    const registry = new ActionRegistry();
    registerSeekActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    await registry.get('timeseek')?.(context, ['90']);
    await registry.get('seek')?.(context, ['5']);
    await registry.get('trackseek')?.(context, ['3']);

    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.values),
      [
        { unit: 'REL_TIME', value: '00:01:30' },
        { unit: 'REL_TIME', value: '00:00:05' },
        { unit: 'TRACK_NR', value: 3 },
      ],
    );
    await assert.rejects(
      registry.get('trackseek')?.(context, ['0']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
    await assert.rejects(
      registry.get('timeseek')?.(context, ['soon']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });
});
