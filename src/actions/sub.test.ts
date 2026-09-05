import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createActionContext } from '../testing/action-context.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { ActionRegistry } from './registry.ts';
import { registerSubActions } from './sub.ts';

describe('sub action', () => {
  it('rejects rooms without a SUB', async () => {
    const registry = new ActionRegistry();
    registerSubActions(registry);
    const { context } = createActionContext();

    await assert.rejects(
      registry.get('sub')?.(context, ['on']) ?? Promise.reject(new Error()),
      /no SUB/,
    );
  });

  it('controls the SUB and validates values', async () => {
    const registry = new ActionRegistry();
    registerSubActions(registry);
    const system = new FakeSystem();
    const { player, soap } = createTestPlayer({
      system,
      roomName: 'TV',
      channelmapset: 'RINCON_1:LF,RF;RINCON_2:SW,SW',
    });
    system.addStandalone(player);
    const { context } = createActionContext();
    const ctx = { ...context, system, player };
    const sub = registry.get('sub');
    assert.ok(sub);

    await sub(ctx, ['on']);
    await sub(ctx, ['off']);
    await sub(ctx, ['gain', '-4']);
    await sub(ctx, ['crossover', '80']);
    await sub(ctx, ['polarity', '1']);
    assert.deepEqual(
      soap.calls.map((c) => c.values),
      [
        { eqType: 'SubEnable', value: 1 },
        { eqType: 'SubEnable', value: 0 },
        { eqType: 'SubGain', value: -4 },
        { eqType: 'SubCrossover', value: 80 },
        { eqType: 'SubPolarity', value: 1 },
      ],
    );
    await assert.rejects(sub(ctx, ['gain', '20']), BadRequestError);
    await assert.rejects(sub(ctx, ['louder']), /expects on, off, gain/);
  });
});
