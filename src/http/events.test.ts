import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { EventHub } from './events.ts';
import type { SseClient } from './events.ts';

function fakeClient(options: { failEvents?: boolean; failComments?: boolean } = {}) {
  const events: string[] = [];
  const comments: string[] = [];
  const client: SseClient = {
    writeEvent: (data) => {
      if (options.failEvents) {
        return Promise.reject(new Error('socket closed'));
      }

      events.push(data);
      return Promise.resolve();
    },
    writeComment: (text) => {
      if (options.failComments) {
        throw new Error('sync failure');
      }

      comments.push(text);
    },
  };
  return { client, events, comments };
}

describe('EventHub', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('broadcasts to every client and tracks the client count', () => {
    const hub = new EventHub();
    const a = fakeClient();
    const b = fakeClient();
    hub.add(a.client);
    hub.add(b.client);

    hub.broadcast('{"type":"volume-change"}');

    assert.equal(hub.size, 2);
    assert.deepEqual(a.events, ['{"type":"volume-change"}']);
    assert.deepEqual(b.events, ['{"type":"volume-change"}']);

    hub.remove(a.client);
    hub.remove(a.client);
    hub.broadcast('again');
    assert.equal(hub.size, 1);
    assert.deepEqual(a.events.length, 1);
    assert.deepEqual(b.events.length, 2);
  });

  it('sends keep-alive comments while clients are connected', () => {
    const hub = new EventHub({ keepAliveMs: 1000 });
    const a = fakeClient();
    hub.add(a.client);

    mock.timers.tick(2000);
    assert.deepEqual(a.comments, ['keep-alive', 'keep-alive']);

    hub.remove(a.client);
    mock.timers.tick(5000);
    assert.equal(a.comments.length, 2, 'the timer stops when nobody is connected');

    hub.add(a.client);
    mock.timers.tick(1000);
    assert.equal(a.comments.length, 3, 'and restarts with the next client');
    hub.close();
    mock.timers.tick(1000);
    assert.equal(a.comments.length, 3);
    assert.equal(hub.size, 0);
  });

  it('drops clients whose writes fail, asynchronously or synchronously', async () => {
    const { logger, messages } = captureLogs();
    const hub = new EventHub({ logger, keepAliveMs: 1000 });
    const broken = fakeClient({ failEvents: true });
    const brokenComment = fakeClient({ failComments: true });
    const healthy = fakeClient();
    hub.add(broken.client);
    hub.add(brokenComment.client);
    hub.add(healthy.client);

    hub.broadcast('x');
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);

    assert.equal(hub.size, 1);
    assert.deepEqual(healthy.events, ['x']);
    assert.equal(messages().filter((m) => m.includes('dropping event client')).length, 2);
  });
});
