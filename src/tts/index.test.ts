import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import type { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

import { settingsSchema } from '../config/schema.ts';
import { ServiceUnavailableError } from '../http/errors.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { createTtsService } from './index.ts';

describe('createTtsService', () => {
  it('has no providers and answers 503 without an aws section', async () => {
    const service = createTtsService(settingsSchema.parse({}));

    assert.deepEqual(service.providers, []);
    await assert.rejects(service.speak({ phrase: 'hi' }), ServiceUnavailableError);
  });

  it('uses Polly with the settings voice (legacy name key), engine and region', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'tts'));
      const send = mock.fn((_command: SynthesizeSpeechCommand) =>
        Promise.resolve({
          AudioStream: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
        }),
      );
      const settings = settingsSchema.parse({
        webroot: dir,
        aws: { name: 'Amy', engine: 'standard', credentials: { region: 'eu-west-1' } },
      });
      const service = createTtsService(settings, {
        pollyClient: { send },
        measureDuration: () => Promise.resolve(900),
      });

      const clip = await service.speak({ phrase: 'Tea time' });

      assert.deepEqual(service.providers, ['polly']);
      assert.equal(clip.durationMs, 900);
      assert.ok(clip.uri.endsWith('-Amy-standard.mp3'));
      assert.equal(send.mock.calls[0]?.arguments[0].input.VoiceId, 'Amy');
    });
  });
});
