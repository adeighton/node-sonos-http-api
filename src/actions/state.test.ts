import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { registerStateActions } from './state.ts';

describe('state action', () => {
  it('returns the frozen player snapshot', async () => {
    const registry = new ActionRegistry();
    registerStateActions(registry);
    const { context, player } = createActionContext();
    await player.handleLastChange({ volume: [{ channel: 'Master', val: '33' }] });

    const state = (await registry.get('state')?.(context, [])) as { volume: number };

    assert.equal(state.volume, 33);
    assert.ok(Object.isFrozen(state));
  });
});
