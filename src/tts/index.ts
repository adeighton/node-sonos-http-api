import { join } from 'node:path';

import type { Settings } from '../config/schema.ts';
import { ServiceUnavailableError } from '../http/errors.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { ClipCache } from './cache.ts';
import { DurationIndex } from './duration-index.ts';
import {
  DEFAULT_POLLY_VOICE,
  createPollyClient,
  createPollyProvider,
  toHttpError,
} from './polly.ts';
import type { PollyClientLike } from './polly.ts';
import type { Clip, TtsProvider, TtsRequest } from './provider.ts';
import { VoiceCatalog } from './voices.ts';

export type { Clip, TtsProvider, TtsRequest } from './provider.ts';
export type { PollyVoice } from './voices.ts';

/** What actions use: speech for a phrase, from whichever provider is configured first. */
export interface TtsService {
  readonly providers: readonly string[];
  /** Polly's voice catalog; absent when no Polly provider is configured. */
  readonly catalog?: VoiceCatalog;
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
  const dir = join(settings.webroot, 'tts');
  const cache = new ClipCache({
    dir,
    logger,
    durations: new DurationIndex({
      file: join(dir, 'durations.json'),
      measure: deps.measureDuration,
      logger,
    }),
  });

  const providers: TtsProvider[] = [];
  let catalog: VoiceCatalog | undefined;
  if (settings.aws) {
    const credentials =
      settings.aws.credentials?.accessKeyId && settings.aws.credentials.secretAccessKey
        ? {
            accessKeyId: settings.aws.credentials.accessKeyId,
            secretAccessKey: settings.aws.credentials.secretAccessKey,
          }
        : undefined;
    const client =
      deps.pollyClient ??
      createPollyClient({ region: settings.aws.credentials?.region, credentials });
    catalog = new VoiceCatalog({ client, logger });
    providers.push(
      createPollyProvider(
        {
          voice: settings.aws.voice ?? settings.aws.name ?? DEFAULT_POLLY_VOICE,
          engine: settings.aws.engine,
          maxConcurrency: settings.aws.maxConcurrency,
          timeoutMs: settings.aws.timeoutMs,
          chunkTargetChars: settings.aws.chunkTargetChars,
        },
        { cache, client, catalog, logger },
      ),
    );
  }

  logger.info(
    { providers: providers.map((provider) => provider.name) },
    'text-to-speech providers',
  );

  return {
    providers: providers.map((provider) => provider.name),
    catalog,
    async speak(request) {
      const provider = providers[0];
      if (!provider) {
        throw new ServiceUnavailableError(NO_TTS_MESSAGE);
      }

      try {
        return await provider.synthesize(request);
      } catch (error) {
        throw toHttpError(error);
      }
    },
  };
}
