import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  DescribeVoicesCommand,
  PollyClient,
  SynthesizeSpeechCommand,
  VoiceId,
} from '@aws-sdk/client-polly';
import type { PollyClientConfig } from '@aws-sdk/client-polly';

import { POLLY_ENGINES } from '../config/schema.ts';
import type { PollyEngine } from '../config/schema.ts';
import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  HttpError,
  ServiceUnavailableError,
} from '../http/errors.ts';
import { createLimiter } from '../util/parallel.ts';
import type { ClipCache } from './cache.ts';
import { chunkSpeech } from './chunk.ts';
import { concatMp3 } from './mp3.ts';
import { normalizeForSpeech } from './normalize.ts';
import type { Clip, TtsProvider, TtsRequest } from './provider.ts';
import type { VoiceCatalog } from './voices.ts';

export interface PollyAudio {
  transformToByteArray(): Promise<Uint8Array>;
}

/** The fields of a DescribeVoices entry this server reads (the SDK's type has many more). */
export interface PollyVoiceInfo {
  Id?: string | undefined;
  SupportedEngines?: string[] | undefined;
  Gender?: string | undefined;
  LanguageCode?: string | undefined;
  LanguageName?: string | undefined;
}

export interface PollyResponse {
  AudioStream?: PollyAudio | undefined;
  Voices?: PollyVoiceInfo[] | undefined;
}

export type PollyCommand = SynthesizeSpeechCommand | DescribeVoicesCommand;

export interface PollySendOptions {
  abortSignal?: AbortSignal;
}

/** The two calls this package makes; the real client is wrapped so tests can inject a fake. */
export interface PollyClientLike {
  send(command: PollyCommand, options?: PollySendOptions): Promise<PollyResponse>;
}

export interface PollyClientOptions {
  region?: string | undefined;
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
  /** Per-attempt request timeout in the SDK; default 15 s. */
  requestTimeoutMs?: number;
}

export interface PollyProviderOptions {
  voice: string;
  engine: PollyEngine;
  /** Chunks synthesized at once; default 6 (Polly allows 8 neural requests per second). */
  maxConcurrency?: number;
  /** Deadline for one chunk; default 20 s. */
  timeoutMs?: number;
  /** Preferred chunk size in billed characters; default 800. */
  chunkTargetChars?: number;
}

export interface PollyProviderDeps {
  cache: ClipCache;
  client: PollyClientLike;
  /** Validates voice/engine pairs before synthesizing; optional. */
  catalog?: VoiceCatalog;
}

export const DEFAULT_POLLY_VOICE = 'Joanna';
export const DEFAULT_POLLY_REGION = 'us-east-1';
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 20_000;

const KNOWN_VOICES: ReadonlySet<string> = new Set(Object.values(VoiceId));

/** Narrows a user-supplied voice name to one Polly knows; unknown names are a 400. */
export function parseVoiceId(voice: string): VoiceId {
  if (!KNOWN_VOICES.has(voice)) {
    throw new BadRequestError(`Unknown Polly voice '${voice}'`);
  }

  return voice as VoiceId;
}

function parseEngine(engine: string): PollyEngine {
  if (!POLLY_ENGINES.includes(engine as PollyEngine)) {
    throw new BadRequestError(
      `Unknown Polly engine '${engine}'; expected one of ${POLLY_ENGINES.join(', ')}`,
    );
  }

  return engine as PollyEngine;
}

/** The cache file name for a phrase: stable across restarts, unique per voice and engine. */
export function pollyClipName(phrase: string, voice: string, engine: PollyEngine): string {
  const hash = createHash('sha1').update(normalizeForSpeech(phrase).body).digest('hex');
  return `polly-${hash}-${voice}-${engine}.mp3`;
}

/** One PollyClient per process, with retries and a per-attempt timeout. */
export function createPollyClient(options: PollyClientOptions = {}): PollyClientLike {
  const config: PollyClientConfig = {
    region: options.region ?? DEFAULT_POLLY_REGION,
    maxAttempts: 3,
    retryMode: 'adaptive',
    requestHandler: { requestTimeout: options.requestTimeoutMs ?? 15_000 },
  };
  if (options.credentials) {
    config.credentials = options.credentials;
  }

  const client = new PollyClient(config);
  return {
    send: (command, sendOptions) =>
      command instanceof DescribeVoicesCommand
        ? client.send(command, sendOptions)
        : client.send(command, sendOptions),
  };
}

/** Polly's MP3 sample rates: standard voices top out at 22.05 kHz. */
function sampleRateFor(engine: PollyEngine): string {
  return engine === 'standard' ? '22050' : '24000';
}

interface ErrorLike {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const THROTTLED = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
]);
const BAD_INPUT = new Set([
  'TextLengthExceededException',
  'InvalidSsmlException',
  'SsmlMarksNotSupportedForTextTypeException',
  'EngineNotSupportedException',
  'InvalidSampleRateException',
  'LexiconNotFoundException',
  'LanguageNotSupportedException',
  'UnsupportedPlsLanguageException',
]);
const MISCONFIGURED = new Set([
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'AccessDeniedException',
  'ExpiredTokenException',
  'UnauthorizedException',
]);

/** Maps an AWS SDK / Polly failure to the HTTP error a client can act on. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  const like = (typeof error === 'object' && error !== null ? error : {}) as ErrorLike;
  const name = like.name ?? '';
  const message = like.message ?? String(error);
  if (THROTTLED.has(name)) {
    return new ServiceUnavailableError('Text-to-speech is being throttled; try again shortly', {
      cause: error,
      headers: { 'Retry-After': '2' },
    });
  }

  if (BAD_INPUT.has(name)) {
    return new BadRequestError(`Polly rejected the text (${name}): ${message}`, { cause: error });
  }

  if (MISCONFIGURED.has(name)) {
    return new ServiceUnavailableError(
      `Text-to-speech is misconfigured (${name}); check the AWS credentials and region`,
      { cause: error },
    );
  }

  if (name === 'AbortError' || name === 'TimeoutError') {
    return new GatewayTimeoutError('Polly did not answer in time', { cause: error });
  }

  return new BadGatewayError(`Polly failed: ${message}`, { cause: error });
}

/**
 * Text-to-speech through Amazon Polly, cached on disk. Long text is synthesized in paragraph
 * chunks in parallel and the MP3 frames are joined, so a briefing of any length is one clip.
 */
export function createPollyProvider(
  options: PollyProviderOptions,
  deps: PollyProviderDeps,
): TtsProvider {
  const limit = createLimiter(options.maxConcurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function assertSupported(voice: VoiceId, engine: PollyEngine): Promise<void> {
    if (!deps.catalog) {
      return;
    }

    if ((await deps.catalog.supports(voice, engine)) === 'no') {
      const engines = await deps.catalog.enginesFor(voice);
      throw new BadRequestError(
        engines.length > 0
          ? `Voice '${voice}' does not support the ${engine} engine; it supports ${engines.join(', ')}`
          : `Polly has no voice named '${voice}'`,
      );
    }
  }

  async function synthesizeChunk(
    text: string,
    voice: VoiceId,
    engine: PollyEngine,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const abortSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const response = await deps.client.send(
      new SynthesizeSpeechCommand({
        OutputFormat: 'mp3',
        SampleRate: sampleRateFor(engine),
        VoiceId: voice,
        Engine: engine,
        TextType: 'ssml',
        Text: text,
      }),
      { abortSignal },
    );
    if (!response.AudioStream) {
      throw new BadGatewayError('Polly answered without audio');
    }

    return response.AudioStream.transformToByteArray();
  }

  return {
    name: 'polly',
    async synthesize(request: TtsRequest): Promise<Clip> {
      const voice = parseVoiceId(request.voice ?? options.voice);
      const engine = request.engine === undefined ? options.engine : parseEngine(request.engine);
      await assertSupported(voice, engine);

      const speech = normalizeForSpeech(request.phrase);
      const chunks = chunkSpeech(speech, { targetChars: options.chunkTargetChars });
      const filename = pollyClipName(speech.body, voice, engine);
      const started = Date.now();

      const clip = await deps.cache.getOrCreate(filename, async (temporary) => {
        const parts = await Promise.all(
          chunks.map((chunk) => limit(() => synthesizeChunk(chunk, voice, engine, request.signal))),
        );
        const joined = concatMp3(parts);
        await writeFile(temporary, joined.bytes);
        return joined.durationMs;
      });

      return {
        ...clip,
        synthMs: clip.cached ? 0 : Date.now() - started,
        chunks: chunks.length,
      };
    },
  };
}
