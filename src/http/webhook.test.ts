import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { buildEventBody, createWebhookNotifier } from './webhook.ts';

const settings = {
  webhook: 'https://hooks.example.com/sonos',
  webhookType: 'type',
  webhookData: 'data',
};

describe('buildEventBody', () => {
  it('uses the configured key names', () => {
    assert.equal(
      buildEventBody(settings, 'volume-change', { roomName: 'Kitchen' }),
      '{"type":"volume-change","data":{"roomName":"Kitchen"}}',
    );
    assert.equal(
      buildEventBody({ ...settings, webhookType: 'event', webhookData: 'payload' }, 'x', 1),
      '{"event":"x","payload":1}',
    );
  });
});

describe('createWebhookNotifier', () => {
  it('is disabled without a webhook url', () => {
    assert.equal(
      createWebhookNotifier({ settings: { ...settings, webhook: undefined } }),
      undefined,
    );
  });

  it('POSTs the body as JSON with the optional custom header and a timeout', async () => {
    const { fetch, calls } = fakeFetch({ 'https://hooks.example.com/sonos': { status: 204 } });
    const notify = createWebhookNotifier({
      settings: { ...settings, webhookHeaderName: 'X-Token', webhookHeaderContents: 'abc' },
      fetch,
    });
    assert.ok(notify);

    await notify('{"type":"x"}');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal(calls[0]?.init?.body, '{"type":"x"}');
    assert.deepEqual(calls[0]?.init?.headers, {
      'content-type': 'application/json',
      'X-Token': 'abc',
    });
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
  });

  it('logs error statuses and network failures without throwing', async () => {
    const { logger, messages } = captureLogs();
    const { fetch } = fakeFetch({ 'https://hooks.example.com/sonos': { status: 500 } });
    const notify = createWebhookNotifier({ settings, fetch, logger });
    const failing = createWebhookNotifier({ settings, fetch: fakeFetch({}).fetch, logger });
    assert.ok(notify && failing);

    await notify('{}');
    await failing('{}');

    assert.ok(messages().some((m) => m.includes('error status')));
    assert.ok(messages().some((m) => m.includes('could not reach the webhook')));
  });
});
