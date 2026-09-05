import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { ActionRegistry } from '../actions/registry.ts';
import type { ActionContext } from '../actions/registry.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { decodePathSegments, normalizeResult, resolveRequest, runAction } from './dispatch.ts';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from './errors.ts';

function systemWithRooms(...rooms: string[]) {
  const system = new FakeSystem();
  const players = rooms.map((room, index) => {
    const { player } = createTestPlayer({ system, roomName: room, uuid: `RINCON_${index}` });
    system.addStandalone(player);
    return player;
  });
  return { system, players };
}

describe('decodePathSegments', () => {
  it('splits and decodes each segment once, keeping encoded slashes inside values', () => {
    assert.deepEqual(decodePathSegments('/1.%20Family%20Room/volume/10'), [
      '1. Family Room',
      'volume',
      '10',
    ]);
    assert.deepEqual(decodePathSegments('/say/100%25%20done/20'), ['say', '100% done', '20']);
    assert.deepEqual(decodePathSegments('/setavtransporturi/x-rincon%3A%2F%2Fhost%2Fa'), [
      'setavtransporturi',
      'x-rincon://host/a',
    ]);
    assert.deepEqual(decodePathSegments('/say/hello/'), ['say', 'hello', '']);
    assert.deepEqual(decodePathSegments('/'), []);
    assert.deepEqual(decodePathSegments(''), []);
  });

  it('rejects malformed percent escapes with a 400', () => {
    assert.throws(
      () => decodePathSegments('/say/100%'),
      (error: unknown) =>
        error instanceof BadRequestError && /could not be URI decoded/.test(error.message),
    );
  });
});

describe('resolveRequest', () => {
  it('uses the named room (case-insensitively) and the following segments as action and values', () => {
    const { system, players } = systemWithRooms('Kitchen', 'Office');

    const resolved = resolveRequest(system, ['office', 'Volume', '10', 'extra']);

    assert.equal(resolved.player, players[1]);
    assert.equal(resolved.action, 'volume');
    assert.deepEqual(resolved.values, ['10', 'extra']);
  });

  it('falls back to any player when the first segment is an action', () => {
    const { system, players } = systemWithRooms('Kitchen');

    const resolved = resolveRequest(system, ['ZONES']);

    assert.equal(resolved.player, players[0]);
    assert.equal(resolved.action, 'zones');
    assert.deepEqual(resolved.values, []);
    assert.equal(resolveRequest(system, []).action, '');
  });

  it('answers 503 until a system has been discovered', () => {
    const system = new FakeSystem();

    assert.throws(() => resolveRequest(system, ['zones']), ServiceUnavailableError);
  });
});

describe('runAction', () => {
  const context = {} as ActionContext;

  it('runs the action and normalizes empty results to a success body', async () => {
    const registry = new ActionRegistry();
    const action = mock.fn((_context: ActionContext, values: string[]) =>
      Promise.resolve(values.length === 0 ? undefined : { echoed: values }),
    );
    registry.register('echo', action, { usage: '/echo', description: '' });

    assert.deepEqual(await runAction(registry, context, 'echo', []), { status: 'success' });
    assert.deepEqual(await runAction(registry, context, 'ECHO', ['a']), { echoed: ['a'] });
    assert.equal(action.mock.calls[0]?.arguments[0], context);
  });

  it('answers 404 for unknown actions', async () => {
    const registry = new ActionRegistry();

    await assert.rejects(runAction(registry, context, 'nope', []), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.message, "Action 'nope' not found");
      return true;
    });
  });

  it('normalizes null and undefined only', () => {
    assert.deepEqual(normalizeResult(undefined), { status: 'success' });
    assert.deepEqual(normalizeResult(null), { status: 'success' });
    assert.deepEqual(normalizeResult(0), 0);
    assert.deepEqual(normalizeResult(['a']), ['a']);
  });
});
