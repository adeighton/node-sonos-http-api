import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActionRegistry } from './index.ts';

describe('createActionRegistry', () => {
  it('registers every action name the API offers', () => {
    const registry = createActionRegistry();

    assert.deepEqual(registry.names(), [
      'groupvolume',
      'next',
      'pause',
      'play',
      'playpause',
      'preset',
      'previous',
      'state',
      'volume',
      'zones',
    ]);
    for (const entry of registry.list()) {
      assert.ok(entry.meta.usage.startsWith('/'), `${entry.name} has a usage line`);
      assert.ok(entry.meta.description.length > 0, `${entry.name} has a description`);
    }
  });
});
