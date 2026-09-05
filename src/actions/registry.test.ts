import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActionRegistry } from './registry.ts';

const noop = () => Promise.resolve();

describe('ActionRegistry', () => {
  it('registers actions with aliases, case-insensitively', () => {
    const registry = new ActionRegistry();
    registry.register('Favorite', noop, { usage: '/favorite/{name}', description: 'x' }, [
      'Favourite',
    ]);

    assert.equal(registry.get('favorite'), noop);
    assert.equal(registry.get('FAVOURITE'), noop);
    assert.equal(registry.has('favourite'), true);
    assert.equal(registry.get('nope'), undefined);
    assert.deepEqual(registry.names(), ['favorite', 'favourite']);
    assert.deepEqual(
      registry.list().map((entry) => entry.name),
      ['favorite'],
    );
    assert.deepEqual(registry.list()[0]?.aliases, ['favourite']);
  });

  it('lists primary entries sorted by name', () => {
    const registry = new ActionRegistry();
    registry.register('zones', noop, { usage: '/zones', description: 'z' });
    registry.register('play', noop, { usage: '/play', description: 'p' });

    assert.deepEqual(
      registry.list().map((entry) => entry.name),
      ['play', 'zones'],
    );
  });

  it('rejects duplicate names and aliases', () => {
    const registry = new ActionRegistry();
    registry.register('mute', noop, { usage: '/mute', description: 'm' }, ['silence']);

    assert.throws(
      () => registry.register('MUTE', noop, { usage: '', description: '' }),
      /already registered/,
    );
    assert.throws(
      () => registry.register('quiet', noop, { usage: '', description: '' }, ['silence']),
      /silence/,
    );
    assert.deepEqual(
      registry.names(),
      ['mute', 'silence'],
      'a failed registration leaves nothing behind',
    );
  });
});
