import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import type { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

import { withTempDir } from '../testing/with-temp-dir.ts';
import { ClipCache } from './cache.ts';
import { createPollyProvider, isSsml, pollyClipName } from './polly.ts';
import type { PollyClientLike } from './polly.ts';

function fakeClient(bytes = 'ID3fake') {
  const send = mock.fn((_command: SynthesizeSpeechCommand) =>
    Promise.resolve({
      AudioStream: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(bytes)) },
    }),
  );
  const client: PollyClientLike = { send };
  return { client, send };
}

describe('polly provider', () => {
  it('detects SSML and builds stable, voice- and engine-specific file names', () => {
    assert.equal(isSsml('<speak>Hi</speak>'), true);
    assert.equal(isSsml('  <speak>Hi</speak> '), true);
    assert.equal(isSsml('Hi <speak>'), false);
    assert.equal(
      pollyClipName('Hello', 'Joanna', 'neural'),
      pollyClipName('Hello', 'Joanna', 'neural'),
    );
    assert.notEqual(
      pollyClipName('Hello', 'Joanna', 'neural'),
      pollyClipName('Hello', 'Matthew', 'neural'),
    );
    assert.notEqual(
      pollyClipName('Hello', 'Joanna', 'neural'),
      pollyClipName('Hello', 'Joanna', 'standard'),
    );
    assert.match(
      pollyClipName('Hello', 'Joanna', 'neural'),
      /^polly-[0-9a-f]{40}-Joanna-neural\.mp3$/,
    );
  });

  it('synthesizes through the client with the configured voice and engine and caches the file', async () => {
    await withTempDir(async (dir) => {
      const { client, send } = fakeClient();
      const cache = new ClipCache({ dir, measureDuration: () => Promise.resolve(2100) });
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache, client },
      );

      const clip = await provider.synthesize({ phrase: 'Dinner is ready' });
      const again = await provider.synthesize({ phrase: 'Dinner is ready' });

      assert.equal(provider.name, 'polly');
      assert.equal(clip.durationMs, 2100);
      assert.match(clip.uri, /^\/tts\/polly-[0-9a-f]{40}-Joanna-neural\.mp3$/);
      assert.deepEqual(again, clip);
      assert.equal(send.mock.callCount(), 1, 'the second call is served from the cache');
      const input = send.mock.calls[0]?.arguments[0].input;
      assert.deepEqual(input, {
        OutputFormat: 'mp3',
        VoiceId: 'Joanna',
        Engine: 'neural',
        TextType: 'text',
        Text: 'Dinner is ready',
      });
      assert.equal(
        await readFile(join(dir, decodeURIComponent(clip.uri.slice('/tts/'.length))), 'utf8'),
        'ID3fake',
      );
    });
  });

  it('uses the requested voice and SSML text type', async () => {
    await withTempDir(async (dir) => {
      const { client, send } = fakeClient();
      const cache = new ClipCache({ dir, measureDuration: () => Promise.resolve(1) });
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'standard' },
        { cache, client },
      );

      const clip = await provider.synthesize({ phrase: '<speak>Hi</speak>', voice: 'Matthew' });

      assert.equal(send.mock.calls[0]?.arguments[0].input.TextType, 'ssml');
      assert.equal(send.mock.calls[0]?.arguments[0].input.VoiceId, 'Matthew');
      assert.equal(send.mock.calls[0]?.arguments[0].input.Engine, 'standard');
      assert.ok(clip.uri.includes('-Matthew-standard.mp3'));
    });
  });

  it('fails loudly (and leaves no file) when Polly answers without audio', async () => {
    await withTempDir(async (dir) => {
      const client: PollyClientLike = { send: () => Promise.resolve({}) };
      const cache = new ClipCache({ dir, measureDuration: () => Promise.resolve(1) });
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache, client },
      );

      await assert.rejects(provider.synthesize({ phrase: 'x' }), /without audio/);
    });
  });
});

describe('parseVoiceId', () => {
  it('accepts Polly voices and rejects unknown names with a 400', async () => {
    const { parseVoiceId } = await import('./polly.ts');
    const { BadRequestError } = await import('../http/errors.ts');
    assert.equal(parseVoiceId('Joanna'), 'Joanna');
    assert.throws(() => parseVoiceId('Dave'), BadRequestError);
  });
});
