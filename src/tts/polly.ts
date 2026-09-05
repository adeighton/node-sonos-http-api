import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { PollyClient, SynthesizeSpeechCommand, VoiceId } from '@aws-sdk/client-polly';
import type { PollyClientConfig } from '@aws-sdk/client-polly';

import type { PollyEngine } from '../config/schema.ts';
import { BadRequestError } from '../http/errors.ts';
import type { ClipCache } from './cache.ts';
import type { Clip, TtsProvider, TtsRequest } from './provider.ts';

export interface PollyAudio {
  transformToByteArray(): Promise<Uint8Array>;
}

/** The one call this provider makes; the real client is wrapped so tests can inject a fake. */
export interface PollyClientLike {
  send(command: SynthesizeSpeechCommand): Promise<{ AudioStream?: PollyAudio | undefined }>;
}

export interface PollyProviderOptions {
  voice: string;
  engine: PollyEngine;
  region?: string | undefined;
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

export interface PollyProviderDeps {
  cache: ClipCache;
  client?: PollyClientLike;
}

export const DEFAULT_POLLY_VOICE = 'Joanna';
export const DEFAULT_POLLY_REGION = 'us-east-1';

const KNOWN_VOICES: ReadonlySet<string> = new Set(Object.values(VoiceId));

/** Narrows a user-supplied voice name to one Polly knows; unknown names are a 400. */
export function parseVoiceId(voice: string): VoiceId {
  if (!KNOWN_VOICES.has(voice)) {
    throw new BadRequestError(`Unknown Polly voice '${voice}'`);
  }

  return voice as VoiceId;
}

export function isSsml(phrase: string): boolean {
  const trimmed = phrase.trim();
  return trimmed.startsWith('<speak>') && trimmed.endsWith('</speak>');
}

/** The cache file name for a phrase: stable across restarts, unique per voice and engine. */
export function pollyClipName(phrase: string, voice: string, engine: PollyEngine): string {
  const hash = createHash('sha1').update(phrase).digest('hex');
  return `polly-${hash}-${voice}-${engine}.mp3`;
}

function createRealClient(options: PollyProviderOptions): PollyClientLike {
  const config: PollyClientConfig = { region: options.region ?? DEFAULT_POLLY_REGION };
  if (options.credentials) {
    config.credentials = options.credentials;
  }

  const client = new PollyClient(config);
  return { send: (command) => client.send(command) };
}

/** Text-to-speech through Amazon Polly (neural engine by default), cached on disk. */
export function createPollyProvider(
  options: PollyProviderOptions,
  deps: PollyProviderDeps,
): TtsProvider {
  const client = deps.client ?? createRealClient(options);

  return {
    name: 'polly',
    async synthesize(request: TtsRequest): Promise<Clip> {
      const voice = parseVoiceId(request.voice ?? options.voice);
      const filename = pollyClipName(request.phrase, voice, options.engine);

      return deps.cache.getOrCreate(filename, async (temporary) => {
        const response = await client.send(
          new SynthesizeSpeechCommand({
            OutputFormat: 'mp3',
            VoiceId: voice,
            Engine: options.engine,
            TextType: isSsml(request.phrase) ? 'ssml' : 'text',
            Text: request.phrase,
          }),
        );
        if (!response.AudioStream) {
          throw new Error('Polly answered without audio');
        }

        await writeFile(temporary, await response.AudioStream.transformToByteArray());
      });
    },
  };
}
