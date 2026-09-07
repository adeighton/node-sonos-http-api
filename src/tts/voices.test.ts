import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { DescribeVoicesCommand } from '@aws-sdk/client-polly';

import { captureLogs } from '../testing/capture-logs.ts';
import type { PollyClientLike, PollyCommand } from './polly.ts';
import { VoiceCatalog } from './voices.ts';

interface VoiceFixture {
  /** Optional, as in the SDK's type: a voice without one is skipped. */
  Id?: string;
  SupportedEngines: string[];
  Gender?: string;
  LanguageCode?: string;
  LanguageName?: string;
}

function describeVoicesClient(voices: VoiceFixture[] | Error) {
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

  it('lists every voice with its gender and language from the same one call', async () => {
    const { client, send } = describeVoicesClient([
      {
        Id: 'Matthew',
        SupportedEngines: ['generative', 'neural', 'standard'],
        Gender: 'Male',
        LanguageCode: 'en-US',
        LanguageName: 'US English',
      },
      { Id: 'Arthur', SupportedEngines: ['neural'], Gender: 'Male', LanguageCode: 'en-GB' },
      { SupportedEngines: ['neural'] }, // no Id: skipped rather than listed as an empty name
    ]);
    const catalog = new VoiceCatalog({ client });

    assert.deepEqual(await catalog.list(), [
      {
        id: 'Matthew',
        gender: 'Male',
        language: 'en-US',
        languageName: 'US English',
        engines: ['generative', 'neural', 'standard'],
      },
      {
        id: 'Arthur',
        gender: 'Male',
        language: 'en-GB',
        languageName: '',
        engines: ['neural'],
      },
    ]);
    assert.equal(await catalog.supports('Arthur', 'neural'), 'yes');
    assert.equal(send.mock.callCount(), 1, 'listing costs no extra DescribeVoices call');
  });

  it('answers unknown, with a warning, when the list cannot be fetched', async () => {
    const logs = captureLogs();
    const { client, send } = describeVoicesClient(new Error('network down'));
    const catalog = new VoiceCatalog({ client, logger: logs.logger, ttlMs: 60_000 });

    assert.equal(await catalog.supports('Ruth', 'neural'), 'unknown');
    assert.deepEqual(await catalog.enginesFor('Ruth'), []);
    assert.deepEqual(await catalog.list(), [], 'the caller draws a form, not an error page');
    assert.ok(logs.messages().some((m) => m.includes('could not list Polly voices')));
    // A failed fetch is not cached for the whole ttl; every call tries again.
    assert.equal(send.mock.callCount(), 3);
    await catalog.supports('Ruth', 'neural');
    assert.equal(send.mock.callCount(), 4);
  });
});
