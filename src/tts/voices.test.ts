import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { DescribeVoicesCommand } from '@aws-sdk/client-polly';

import { captureLogs } from '../testing/capture-logs.ts';
import type { PollyClientLike, PollyCommand } from './polly.ts';
import { VoiceCatalog } from './voices.ts';

function describeVoicesClient(voices: Array<{ Id: string; SupportedEngines: string[] }> | Error) {
  const send = mock.fn((command: PollyCommand) => {
    assert.ok(command instanceof DescribeVoicesCommand);
    return voices instanceof Error ? Promise.reject(voices) : Promise.resolve({ Voices: voices });
  });
  const client: PollyClientLike = { send };
  return { client, send };
}

describe('VoiceCatalog', () => {
  it('answers yes / no from one DescribeVoices call and lists the engines of a voice', async () => {
    const { client, send } = describeVoicesClient([
      { Id: 'Ruth', SupportedEngines: ['neural', 'generative'] },
      { Id: 'Brian', SupportedEngines: ['standard', 'neural', 'generative'] },
    ]);
    const catalog = new VoiceCatalog({ client });

    assert.equal(await catalog.supports('Ruth', 'neural'), 'yes');
    assert.equal(await catalog.supports('Ruth', 'standard'), 'no');
    assert.deepEqual(await catalog.enginesFor('Ruth'), ['neural', 'generative']);
    assert.equal(await catalog.supports('Nobody', 'neural'), 'no');
    assert.equal(send.mock.callCount(), 1, 'the list is cached');
  });

  it('refreshes after the ttl', async () => {
    let now = 1_000_000;
    const { client, send } = describeVoicesClient([{ Id: 'Ruth', SupportedEngines: ['neural'] }]);
    const catalog = new VoiceCatalog({ client, ttlMs: 1000, now: () => now });

    await catalog.supports('Ruth', 'neural');
    now += 999;
    await catalog.supports('Ruth', 'neural');
    assert.equal(send.mock.callCount(), 1);
    now += 2;
    await catalog.supports('Ruth', 'neural');
    assert.equal(send.mock.callCount(), 2);
  });

  it('answers unknown, with a warning, when the list cannot be fetched', async () => {
    const logs = captureLogs();
    const { client, send } = describeVoicesClient(new Error('network down'));
    const catalog = new VoiceCatalog({ client, logger: logs.logger, ttlMs: 60_000 });

    assert.equal(await catalog.supports('Ruth', 'neural'), 'unknown');
    assert.deepEqual(await catalog.enginesFor('Ruth'), []);
    assert.ok(logs.messages().some((m) => m.includes('could not list Polly voices')));
    // A failed fetch is not cached for the whole ttl; every call tries again.
    assert.equal(send.mock.callCount(), 2);
    await catalog.supports('Ruth', 'neural');
    assert.equal(send.mock.callCount(), 3);
  });
});
