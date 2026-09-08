import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { DescribeVoicesCommand } from '@aws-sdk/client-polly';
import type { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

import { BadGatewayError, BadRequestError, HttpError } from '../http/errors.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { fixturePath } from '../testing/fixtures.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { ClipCache } from './cache.ts';
import { DurationIndex } from './duration-index.ts';
import { concatMp3, parseMp3 } from './mp3.ts';
import {
  connectionErrorCode,
  createPollyProvider,
  parseVoiceId,
  pollyClipName,
  suggestVoices,
  toHttpError,
} from './polly.ts';
import type { PollyClientLike, PollyCommand, PollySendOptions } from './polly.ts';
import { VoiceCatalog } from './voices.ts';

interface FakeOptions {
  /** Resolves each synthesis after this many ms (real timers), to observe concurrency. */
  delayMs?: number;
  voices?: Array<{ Id: string; SupportedEngines: string[] }>;
  fail?: (command: SynthesizeSpeechCommand) => Error | undefined;
}

/** Node's error for an HTTP/2 session that was dropped while it sat in the SDK's pool. */
function sessionClosed(): Error {
  return Object.assign(new Error('Session closed with error code 1'), {
    code: 'ERR_HTTP2_SESSION_ERROR',
  });
}

/** Fails the first `times` synthesis attempts with `error`, then succeeds. */
function failFirst(times: number, error: Error) {
  let left = times;
  return () => (left-- > 0 ? error : undefined);
}

/** A Polly stand-in answering every synthesis with the fixture MP3 and recording the inputs. */
async function fakePolly(options: FakeOptions = {}) {
  const audio = await readFile(fixturePath('clip.mp3'));
  const inputs: SynthesizeSpeechCommand['input'][] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let inFlight = 0;
  let peak = 0;
  const send = mock.fn(async (command: PollyCommand, sendOptions?: PollySendOptions) => {
    if (command instanceof DescribeVoicesCommand) {
      return { Voices: options.voices ?? [] };
    }

    inputs.push(command.input);
    signals.push(sendOptions?.abortSignal);
    const failure = options.fail?.(command);
    if (failure) {
      throw failure;
    }

    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    inFlight -= 1;
    return { AudioStream: { transformToByteArray: () => Promise.resolve(new Uint8Array(audio)) } };
  });
  const client: PollyClientLike = { send };
  return { client, send, inputs, signals, peak: () => peak, audio };
}

function cacheIn(dir: string) {
  return new ClipCache({
    dir,
    durations: new DurationIndex({ file: join(dir, 'durations.json') }),
  });
}

describe('pollyClipName', () => {
  it('is stable, voice- and engine-specific, and keyed on the normalized text', () => {
    assert.equal(
      pollyClipName('Hello', 'Joanna', 'neural'),
      pollyClipName('  Hello ', 'Joanna', 'neural'),
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
});

describe('polly provider', () => {
  it('synthesizes one SSML chunk with the voice, engine and sample rate, then serves the cache', async () => {
    await withTempDir(async (dir) => {
      const polly = await fakePolly();
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: polly.client },
      );

      const clip = await provider.synthesize({ phrase: 'Dinner is ready' });
      const again = await provider.synthesize({ phrase: 'Dinner is ready' });

      assert.equal(provider.name, 'polly');
      assert.deepEqual(polly.inputs, [
        {
          OutputFormat: 'mp3',
          SampleRate: '24000',
          VoiceId: 'Joanna',
          Engine: 'neural',
          TextType: 'ssml',
          Text: '<speak><p>Dinner is ready</p></speak>',
        },
      ]);
      assert.ok(polly.signals[0] instanceof AbortSignal, 'every call carries an abort signal');
      assert.equal(clip.cached, false);
      assert.equal(clip.chunks, 1);
      assert.equal(clip.durationMs, concatMp3([polly.audio]).durationMs);
      assert.match(clip.uri, /^\/tts\/polly-[0-9a-f]{40}-Joanna-neural\.mp3$/);
      assert.equal(again.cached, true);
      assert.equal(again.uri, clip.uri);
      assert.equal(polly.send.mock.callCount(), 1);
    });
  });

  it('uses the requested voice and engine, and the standard sample rate for standard', async () => {
    await withTempDir(async (dir) => {
      const polly = await fakePolly();
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: polly.client },
      );

      const clip = await provider.synthesize({
        phrase: '<speak>Hi</speak>',
        voice: 'Matthew',
        engine: 'standard',
      });

      assert.equal(polly.inputs[0]?.VoiceId, 'Matthew');
      assert.equal(polly.inputs[0]?.Engine, 'standard');
      assert.equal(polly.inputs[0]?.SampleRate, '22050');
      assert.equal(polly.inputs[0]?.Text, '<speak>Hi</speak>');
      assert.ok(clip.uri.includes('-Matthew-standard.mp3'));
    });
  });

  it('splits long text into chunks, synthesizes them concurrently and joins the audio', async () => {
    await withTempDir(async (dir) => {
      const polly = await fakePolly({ delayMs: 20 });
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural', maxConcurrency: 2, chunkTargetChars: 120 },
        { cache: cacheIn(dir), client: polly.client },
      );
      const paragraphs = Array.from(
        { length: 6 },
        (_, i) => `Paragraph ${i} has some words in it, enough to matter.`,
      );

      const clip = await provider.synthesize({ phrase: paragraphs.join('\n\n') });

      assert.ok(clip.chunks !== undefined && clip.chunks >= 3, `chunked: ${clip.chunks}`);
      assert.equal(polly.send.mock.callCount(), clip.chunks);
      assert.equal(polly.peak(), 2, 'never more than maxConcurrency in flight');
      const expected = concatMp3(Array.from({ length: clip.chunks }, () => polly.audio));
      assert.equal(clip.durationMs, expected.durationMs, 'the joined duration');
      const file = join(dir, decodeURIComponent(clip.uri.slice('/tts/'.length)));
      assert.equal(parseMp3(await readFile(file)).frames, expected.frames);
    });
  });

  it('rejects voices Polly does not know, or that do not support the engine', async () => {
    await withTempDir(async (dir) => {
      const polly = await fakePolly({
        voices: [{ Id: 'Ruth', SupportedEngines: ['neural', 'generative'] }],
      });
      const catalog = new VoiceCatalog({ client: polly.client });
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: polly.client, catalog },
      );

      await assert.rejects(
        provider.synthesize({ phrase: 'x', voice: 'Gandalf' }),
        (error: unknown) =>
          error instanceof BadRequestError &&
          error.message ===
            "Unknown Polly voice 'Gandalf'; GET /voices lists the voices Polly offers",
      );
      // The usual reason a voice is unknown is a misspelling, so the catalog names the near misses.
      await assert.rejects(
        provider.synthesize({ phrase: 'x', voice: 'ruth' }),
        (error: unknown) =>
          error instanceof BadRequestError &&
          error.message === "Unknown Polly voice 'ruth'; did you mean Ruth?",
      );
      await assert.rejects(
        provider.synthesize({ phrase: 'x', voice: 'Ruth', engine: 'standard' }),
        (error: unknown) =>
          error instanceof BadRequestError && /supports neural, generative/.test(error.message),
      );
      assert.equal(polly.inputs.length, 0, 'nothing was synthesized');
    });
  });

  it('takes the live catalog over the SDK list, and the SDK list when there is no catalog', async () => {
    await withTempDir(async (dir) => {
      // A voice added to Polly after the SDK was pinned; the catalog knows it, VoiceId does not.
      const polly = await fakePolly({ voices: [{ Id: 'Newcomer', SupportedEngines: ['neural'] }] });
      const withCatalog = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        {
          cache: cacheIn(dir),
          client: polly.client,
          catalog: new VoiceCatalog({ client: polly.client }),
        },
      );

      const clip = await withCatalog.synthesize({ phrase: 'x', voice: 'Newcomer' });
      assert.equal(polly.inputs[0]?.VoiceId, 'Newcomer');
      assert.ok(clip.uri.includes('-Newcomer-neural.mp3'));
      // Joanna is in the SDK's list but not in this account's catalog, so it is refused here.
      await assert.rejects(
        withCatalog.synthesize({ phrase: 'x', voice: 'Joanna' }),
        (error: unknown) =>
          error instanceof BadRequestError && /Unknown Polly voice 'Joanna'/.test(error.message),
      );

      const noCatalog = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: polly.client },
      );
      await assert.doesNotReject(noCatalog.synthesize({ phrase: 'x', voice: 'Joanna' }));
      await assert.rejects(
        noCatalog.synthesize({ phrase: 'x', voice: 'Newcomer' }),
        (error: unknown) =>
          error instanceof BadRequestError && error.message === "Unknown Polly voice 'Newcomer'",
      );
    });
  });

  it('retries once when the pooled connection to Polly has been dropped', async () => {
    await withTempDir(async (dir) => {
      const logs = captureLogs();
      const polly = await fakePolly({ fail: failFirst(1, sessionClosed()) });
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: polly.client, logger: logs.logger },
      );

      const clip = await provider.synthesize({ phrase: 'Dinner is ready' });

      assert.equal(clip.chunks, 1);
      assert.equal(polly.inputs.length, 2, 'the first attempt died, the second dialled again');
      assert.ok(logs.messages().includes('command failed, retrying'));
    });
  });

  it('gives up on a second connection failure, and never retries what Polly refused', async () => {
    await withTempDir(async (dir) => {
      const dropped = await fakePolly({ fail: failFirst(2, sessionClosed()) });
      const failing = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: dropped.client },
      );
      await assert.rejects(failing.synthesize({ phrase: 'Dinner is ready' }), /Session closed/);
      assert.equal(dropped.inputs.length, 2, 'one retry, not a loop');

      const refused = await fakePolly({
        fail: () => Object.assign(new Error('too long'), { name: 'TextLengthExceededException' }),
      });
      const rejecting = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client: refused.client },
      );
      await assert.rejects(rejecting.synthesize({ phrase: 'Dinner is ready' }), /too long/);
      assert.equal(refused.inputs.length, 1, 'a refusal is an answer, not a broken connection');
    });
  });

  it('fails loudly (and leaves no file) when Polly answers without audio', async () => {
    await withTempDir(async (dir) => {
      const client: PollyClientLike = { send: () => Promise.resolve({}) };
      const provider = createPollyProvider(
        { voice: 'Joanna', engine: 'neural' },
        { cache: cacheIn(dir), client },
      );

      await assert.rejects(provider.synthesize({ phrase: 'x' }), BadGatewayError);
    });
  });
});

describe('toHttpError', () => {
  const named = (name: string, message = name) => Object.assign(new Error(message), { name });

  it('maps Polly and SDK failures to the right statuses', () => {
    const throttled = toHttpError(named('ThrottlingException'));
    assert.equal(throttled.status, 503);
    assert.equal(throttled.headers?.['Retry-After'], '2');
    assert.equal(toHttpError(named('TooManyRequestsException')).status, 503);

    for (const name of [
      'TextLengthExceededException',
      'InvalidSsmlException',
      'EngineNotSupportedException',
      'InvalidSampleRateException',
    ]) {
      const error = toHttpError(named(name, `Polly says: ${name}`));
      assert.equal(error.status, 400, name);
      assert.match(error.message, new RegExp(name));
    }

    for (const name of [
      'CredentialsProviderError',
      'UnrecognizedClientException',
      'InvalidSignatureException',
      'AccessDeniedException',
      'ExpiredTokenException',
    ]) {
      assert.equal(toHttpError(named(name)).status, 503, name);
    }
    assert.match(toHttpError(named('AccessDeniedException')).message, /misconfigured/);

    assert.equal(toHttpError(named('AbortError')).status, 504);
    assert.equal(toHttpError(named('TimeoutError')).status, 504);
    assert.equal(toHttpError(new Error('socket hang up')).status, 502);
  });

  it('passes HttpErrors through untouched', () => {
    const original = new BadRequestError('mine');
    assert.equal(toHttpError(original), original);
    assert.ok(toHttpError(new Error('x')) instanceof HttpError);
  });
});

describe('connection failures', () => {
  it('are a 503 with Retry-After, named by their code, however deeply they are wrapped', () => {
    const session = toHttpError(sessionClosed());
    assert.equal(session.status, 503);
    assert.equal(
      session.message,
      'Could not reach Polly (ERR_HTTP2_SESSION_ERROR); try again shortly',
    );
    assert.deepEqual(session.headers, { 'Retry-After': '2' });

    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    assert.equal(toHttpError(new Error('wrapped', { cause: reset })).status, 503);
    assert.equal(connectionErrorCode(new Error('wrapped', { cause: reset })), 'ECONNRESET');
    assert.equal(connectionErrorCode(new Error('plain')), undefined);
    assert.equal(connectionErrorCode('not an error'), undefined);
    // A request that timed out is still a 504: the connection was fine, Polly was slow.
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    });
    assert.equal(toHttpError(timeout).status, 504);
  });
});

describe('suggestVoices', () => {
  it('names the voices that start the same way, or points at the catalog', () => {
    const voices = [{ id: 'Joanna' }, { id: 'Joey' }, { id: 'Jitka' }, { id: 'Arthur' }];
    assert.equal(suggestVoices(voices, 'Joana'), '; did you mean Joanna?');
    assert.equal(suggestVoices(voices, 'Jo'), '; did you mean Joanna or Joey?');
    assert.equal(suggestVoices(voices, 'arthur'), '; did you mean Arthur?', 'case-insensitive');
    assert.equal(
      suggestVoices(voices, 'Gandalf'),
      '; GET /voices lists the voices Polly offers',
      'nothing close: say where the list is',
    );
    assert.equal(suggestVoices([], 'Joanna'), '', 'no catalog, nothing to suggest');
  });
});

describe('parseVoiceId', () => {
  it('accepts Polly voices and rejects unknown names with a 400', () => {
    assert.equal(parseVoiceId('Joanna'), 'Joanna');
    assert.throws(() => parseVoiceId('Dave'), BadRequestError);
  });
});
