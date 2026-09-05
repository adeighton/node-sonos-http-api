import { join } from 'node:path';

import type { Settings } from '../config/schema.ts';
import { ServiceUnavailableError } from '../http/errors.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { ClipCache } from './cache.ts';
import { DEFAULT_POLLY_VOICE, createPollyProvider } from './polly.ts';
import type { PollyClientLike } from './polly.ts';
import type { Clip, TtsProvider, TtsRequest } from './provider.ts';

export type { Clip, TtsProvider, TtsRequest } from './provider.ts';

/** What actions use: speech for a phrase, from whichever provider is configured first. */
export interface TtsService {
  readonly providers: readonly string[];
  speak(request: TtsRequest): Promise<Clip>;
}

export interface TtsServiceDeps {
  logger?: Logger;
  /** Test hook: replaces the real Polly client. */
  pollyClient?: PollyClientLike;
  measureDuration?: (file: string) => Promise<number>;
}

export const NO_TTS_MESSAGE =
  'No text-to-speech provider is configured. Add an "aws" section to settings.json or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.';

/** Builds the provider chain from settings; today that is Amazon Polly or nothing. */
export function createTtsService(settings: Settings, deps: TtsServiceDeps = {}): TtsService {
  const logger = deps.logger ?? silentLogger;
  const cache = new ClipCache({
    dir: join(settings.webroot, 'tts'),
    logger,
    measureDuration: deps.measureDuration,
  });

  const providers: TtsProvider[] = [];
  if (settings.aws) {
    const credentials =
      settings.aws.credentials?.accessKeyId && settings.aws.credentials.secretAccessKey
        ? {
            accessKeyId: settings.aws.credentials.accessKeyId,
            secretAccessKey: settings.aws.credentials.secretAccessKey,
          }
        : undefined;
    providers.push(
      createPollyProvider(
        {
          voice: settings.aws.voice ?? settings.aws.name ?? DEFAULT_POLLY_VOICE,
          engine: settings.aws.engine,
          region: settings.aws.credentials?.region,
          credentials,
        },
        { cache, client: deps.pollyClient },
      ),
    );
  }

  logger.info(
    { providers: providers.map((provider) => provider.name) },
    'text-to-speech providers',
  );

  return {
    providers: providers.map((provider) => provider.name),
    async speak(request) {
      const provider = providers[0];
      if (!provider) {
        throw new ServiceUnavailableError(NO_TTS_MESSAGE);
      }

      return provider.synthesize(request);
    },
  };
}
