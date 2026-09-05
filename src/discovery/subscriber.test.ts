import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import type { HttpRequestOptions, HttpStreamResponse } from './http.ts';
import { Subscriber } from './subscriber.ts';

function streamResponse(headers: Record<string, string> = {}): HttpStreamResponse {
  return {
    status: 200,
    statusMessage: 'OK',
    headers,
    localAddress: '127.0.0.1',
    stream: Readable.from([]),
  };
}

/** An http client whose replies are scripted per call. */
function scriptedHttp(
  script: Array<HttpStreamResponse | Error>,
  fallback?: HttpStreamResponse | Error,
) {
  const http = mock.fn((_options: HttpRequestOptions): Promise<HttpStreamResponse> => {
    const next = script.shift() ?? fallback;
    if (next === undefined) {
      return Promise.reject(new Error('no scripted reply'));
    }

    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return {
    http,
    calls: () => http.mock.calls.map((call) => call.arguments[0]),
  };
}

const URL = 'http://192.168.1.151:1400/test/path';
const CALLBACK = 'http://127.0.0.2/';

describe('Subscriber', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('sends a subscription with the correct parameters', async () => {
    const { http, calls } = scriptedHttp([streamResponse({ sid: '1234567' })]);
    const subscriber = new Subscriber(
      URL,
      CALLBACK,
      { http },
      { subscriptionIntervalSeconds: 600 },
    );
    await flushPromises();

    assert.deepEqual(calls(), [
      {
        url: URL,
        method: 'SUBSCRIBE',
        headers: { CALLBACK: `<${CALLBACK}>`, NT: 'upnp:event', TIMEOUT: 'Second-600' },
        type: 'stream',
      },
    ]);
    assert.equal(subscriber.sid, '1234567');
    await subscriber.dispose();
  });

  it('retries with a fresh subscription after a failure', async () => {
    const { http, calls } = scriptedHttp([
      new Error('Rejecting subscribe attempt. This is a mocked error'),
      streamResponse({ sid: '1' }),
    ]);
    const subscriber = new Subscriber(
      URL,
      CALLBACK,
      { http },
      { subscriptionIntervalSeconds: 600, retryIntervalMs: 100 },
    );
    await flushPromises();
    mock.timers.tick(100);
    await flushPromises();

    assert.equal(calls().length, 2);
    assert.deepEqual(calls()[1], {
      url: URL,
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<${CALLBACK}>`, NT: 'upnp:event', TIMEOUT: 'Second-600' },
      type: 'stream',
    });
    await subscriber.dispose();
  });

  it('renews with the SID at half the interval and re-subscribes without it after a failure', async () => {
    const { http, calls } = scriptedHttp(
      [streamResponse({ sid: '12345678' }), new Error('renewal failed')],
      streamResponse({ sid: '12345678' }),
    );
    const subscriber = new Subscriber(
      URL,
      CALLBACK,
      { http },
      { subscriptionIntervalSeconds: 0.2, retryIntervalMs: 100 },
    );
    await flushPromises();
    mock.timers.tick(100); // 0.2 s * 500 = 100 ms renewal
    await flushPromises();
    mock.timers.tick(100); // retry
    await flushPromises();

    assert.equal(calls().length, 3);
    assert.deepEqual(calls()[1], {
      url: URL,
      method: 'SUBSCRIBE',
      headers: { TIMEOUT: 'Second-0.2', SID: '12345678' },
      type: 'stream',
    });
    assert.deepEqual(calls()[2], {
      url: URL,
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<${CALLBACK}>`, NT: 'upnp:event', TIMEOUT: 'Second-0.2' },
      type: 'stream',
    });
    await subscriber.dispose();
  });

  it('sends UNSUBSCRIBE with the SID and stops renewing when disposed', async () => {
    const { http, calls } = scriptedHttp([], streamResponse({ sid: '1234567890' }));
    const subscriber = new Subscriber(
      URL,
      CALLBACK,
      { http },
      { subscriptionIntervalSeconds: 0.2 },
    );
    await flushPromises();

    await subscriber.dispose();
    mock.timers.tick(1000);
    await flushPromises();

    assert.equal(calls().length, 2);
    assert.deepEqual(calls()[1], {
      method: 'UNSUBSCRIBE',
      type: 'stream',
      url: URL,
      headers: { SID: '1234567890' },
    });
    assert.equal(subscriber.sid, undefined);
  });

  it('does not send UNSUBSCRIBE when it never got a SID', async () => {
    const { http, calls } = scriptedHttp([], new Error('down'));
    const subscriber = new Subscriber(URL, CALLBACK, { http }, { retryIntervalMs: 100 });
    await flushPromises();

    await subscriber.dispose();

    assert.equal(calls().length, 1);
  });

  it('emits dead after five consecutive failures and logs each one', async () => {
    const { logger, messages } = captureLogs();
    const { http } = scriptedHttp([], new Error('down'));
    const subscriber = new Subscriber(
      URL,
      CALLBACK,
      { http, logger },
      { subscriptionIntervalSeconds: 0.2, retryIntervalMs: 100 },
    );
    const dead = mock.fn();
    subscriber.once('dead', dead);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await flushPromises();
      mock.timers.tick(100);
    }
    await flushPromises();

    assert.equal(dead.mock.callCount(), 1);
    assert.match(String(dead.mock.calls[0]?.arguments[0]), /probably died/);
    assert.ok(messages().filter((message) => message === 'subscribe failed, retrying').length >= 5);
    await subscriber.dispose();
  });

  it('logs but does not throw when UNSUBSCRIBE fails', async () => {
    const { logger, messages } = captureLogs();
    const { http } = scriptedHttp([streamResponse({ sid: 'x' }), new Error('gone')]);
    const subscriber = new Subscriber(URL, CALLBACK, { http, logger });
    await flushPromises();

    await subscriber.dispose();

    assert.ok(messages().includes('unsubscribe failed'));
  });
});
