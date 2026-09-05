import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { parseVolumeValue, registerVolumeActions } from './volume.ts';

describe('volume actions', () => {
  it('validates the volume value', () => {
    assert.equal(parseVolumeValue('50'), '50');
    assert.equal(parseVolumeValue('+5'), '+5');
    assert.equal(parseVolumeValue('-5'), '-5');
    assert.throws(() => parseVolumeValue(undefined), BadRequestError);
    assert.throws(() => parseVolumeValue('loud'), BadRequestError);
    assert.throws(() => parseVolumeValue('5.5'), BadRequestError);
  });

  it('sets the room volume and the group volume', async () => {
    const registry = new ActionRegistry();
    registerVolumeActions(registry);
    const { context, rooms } = createActionContext({ rooms: ['Kitchen'] });
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);

    await registry.get('volume')?.(context, ['+5']);
    assert.deepEqual(kitchen.soap.calls[0]?.values, { volume: 5 });

    await registry.get('groupvolume')?.(context, ['20']);
    assert.equal(kitchen.player.groupState.volume, 20);
    assert.equal(kitchen.soap.calls[1]?.action, SOAP_ACTIONS.Volume);

    await assert.rejects(
      registry.get('volume')?.(context, []) ??
        Promise.reject(new Error('volume action not registered')),
      BadRequestError,
    );
  });
});
