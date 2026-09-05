import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mock } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError } from '../http/errors.ts';
import { flushPromises } from '../testing/async.ts';
import { createActionContext } from '../testing/action-context.ts';
import { registerPauseAllActions } from './pauseall.ts';
import { ActionRegistry } from './registry.ts';

async function setup() {
  const registry = new ActionRegistry();
  registerPauseAllActions(registry);
  const { context, rooms } = createActionContext({ rooms: ['Kitchen', 'Office'] });
  const kitchen = rooms.get('Kitchen');
  const office = rooms.get('Office');
  assert.ok(kitchen && office);
  await kitchen.player.handleLastChange({
    transportstate: { val: 'PLAYING' },
    avtransporturi: { val: 'x-rincon:X' },
  });
  return { registry, context, kitchen, office };
}

describe('pauseall / resumeall', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('pauses only the playing groups and resumes exactly those', async () => {
    const { registry, context, kitchen, office } = await setup();

    await registry.get('pauseall')?.(context, []);
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.Pause],
    );
    assert.equal(office.soap.calls.length, 0);

    await registry.get('resumeall')?.(context, []);
    await registry.get('resumeall')?.(context, []);
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.Pause, SOAP_ACTIONS.Play],
    );
  });

  it('delays by minutes when asked and validates the delay', async () => {
    const { registry, context, kitchen } = await setup();

    await registry.get('pauseall')?.(context, ['2']);
    assert.equal(kitchen.soap.calls.length, 0);
    mock.timers.tick(2 * 60_000);
    await flushPromises();
    assert.deepEqual(
      kitchen.soap.calls.map((c) => c.action),
      [SOAP_ACTIONS.Pause],
    );

    await assert.rejects(
      registry.get('resumeall')?.(context, ['soon']) ?? Promise.reject(new Error()),
      BadRequestError,
    );
  });
});
