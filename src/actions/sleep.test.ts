import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { registerSleepActions } from './sleep.ts';

describe('sleep action', () => {
  it('sets, clears and validates the sleep timer', async () => {
    const registry = new ActionRegistry();
    registerSleepActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const sleep = registry.get('sleep');
    assert.ok(sleep);

    await sleep(context, ['600']);
    await sleep(context, ['OFF']);
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.values),
      [{ time: '00:10:00' }, { time: '' }],
    );
    await assert.rejects(sleep(context, ['later']), BadRequestError);
    await assert.rejects(sleep(context, []), BadRequestError);
  });
});
