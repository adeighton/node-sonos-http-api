import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import { registerPlaybackActions } from './playback.ts';

function setup() {
  const registry = new ActionRegistry();
  registerPlaybackActions(registry);
  const { context, rooms, system } = createActionContext({ rooms: ['Kitchen', 'Office'] });
  const kitchen = rooms.get('Kitchen');
  const office = rooms.get('Office');
  assert.ok(kitchen && office);
  return { registry, context, kitchen, office, system };
}

describe('playback actions', () => {
  it('registers the five playback actions', () => {
    const { registry } = setup();
    assert.deepEqual(registry.names(), ['next', 'pause', 'play', 'playpause', 'previous']);
  });

  it('sends transport commands to the coordinator of the room', async () => {
    const { registry, context, kitchen, office } = setup();
    // Kitchen is grouped under Office: commands go to Office.
    kitchen.player.coordinator = office.player;

    for (const [name, action] of [
      ['play', SOAP_ACTIONS.Play],
      ['pause', SOAP_ACTIONS.Pause],
      ['next', SOAP_ACTIONS.Next],
      ['previous', SOAP_ACTIONS.Previous],
    ] as const) {
      const result = await registry.get(name)?.(context, []);
      assert.equal(result, undefined);
      assert.equal(office.soap.calls.at(-1)?.action, action, name);
    }

    assert.equal(kitchen.soap.calls.length, 0);
  });

  it('playpause pauses when playing and reports the new state', async () => {
    const { registry, context, kitchen } = setup();

    const played = await registry.get('playpause')?.(context, []);
    assert.deepEqual(played, { status: 'success', paused: false });
    assert.equal(kitchen.soap.calls.at(-1)?.action, SOAP_ACTIONS.Play);

    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      avtransporturi: { val: 'x-rincon:RINCON_OTHER' },
    });
    const paused = await registry.get('playpause')?.(context, []);
    assert.deepEqual(paused, { status: 'success', paused: true });
    assert.equal(kitchen.soap.calls.at(-1)?.action, SOAP_ACTIONS.Pause);
  });
});
