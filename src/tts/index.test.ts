import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

import { settingsSchema } from '../config/schema.ts';
import { ServiceUnavailableError } from '../http/errors.ts';
import { fixturePath } from '../testing/fixtures.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { createTtsService } from './index.ts';
import type { PollyClientLike, PollyCommand } from './polly.ts';

async function pollyAnswering(fail?: Error) {
  const audio = new Uint8Array(await readFile(fixturePath('clip.mp3')));
  const send = mock.fn((command: PollyCommand) => {
    if (!(command instanceof SynthesizeSpeechCommand)) {
      return Promise.resolve({ Voices: [{ Id: 'Amy', SupportedEngines: ['standard', 'neural'] }] });
    }

    if (fail) {
      return Promise.reject(fail);
    }

    return Promise.resolve({ AudioStream: { transformToByteArray: () => Promise.resolve(audio) } });
  });
  const client: PollyClientLike = { send };
  return { client, send };
}

describe('createTtsService', () => {
  it('has no providers and answers 503 without an aws section', async () => {
    const service = createTtsService(settingsSchema.parse({}));

    assert.deepEqual(service.providers, []);
    await assert.rejects(service.speak({ phrase: 'hi' }), ServiceUnavailableError);
  });

  it('uses Polly with the settings voice (legacy name key), engine and region', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'tts'));
      const { client, send } = await pollyAnswering();
      const settings = settingsSchema.parse({
        webroot: dir,
        aws: { name: 'Amy', engine: 'standard', credentials: { region: 'eu-west-1' } },
      });
      const service = createTtsService(settings, { pollyClient: client });

      const clip = await service.speak({ phrase: 'Tea time' });

      assert.deepEqual(service.providers, ['polly']);
      assert.ok(clip.durationMs > 1000, 'measured from the synthesized frames');
      assert.equal(clip.cached, false);
      assert.ok(clip.uri.endsWith('-Amy-standard.mp3'));
      const synthesis = send.mock.calls
        .map((call) => call.arguments[0])
        .find((command) => command instanceof SynthesizeSpeechCommand);
      assert.equal(synthesis?.input.VoiceId, 'Amy');
      assert.equal(synthesis?.input.SampleRate, '22050');
    });
  });

  it('maps Polly failures to HTTP errors clients can act on', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'tts'));
      const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      const { client } = await pollyAnswering(throttled);
      const settings = settingsSchema.parse({ webroot: dir, aws: { voice: 'Amy' } });
      const service = createTtsService(settings, { pollyClient: client });

      await assert.rejects(service.speak({ phrase: 'Tea time' }), (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableError);
        assert.equal(error.headers?.['Retry-After'], '2');
        return true;
      });
    });
  });
});
