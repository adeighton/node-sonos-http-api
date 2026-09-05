import assert from 'node:assert/strict';
import http from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import { describe, it, mock } from 'node:test';

import { Hono } from 'hono';

import { captureLogs } from './testing/capture-logs.ts';
import { startServer } from './server.ts';

function app() {
  const hono = new Hono();
  hono.get('/ping', (c) => c.json({ pong: true }));
  return hono;
}

const base = { port: 0, ip: '127.0.0.1', securePort: 0, https: undefined };

describe('startServer', () => {
  it('serves the app over http on the configured interface and closes cleanly', async () => {
    const running = await startServer({ app: app(), settings: base });

    assert.ok(running.port > 0);
    assert.equal(running.securePort, undefined);
    const response = await fetch(`http://127.0.0.1:${running.port}/ping`);
    assert.deepEqual(await response.json(), { pong: true });

    await running.close();
    await assert.rejects(fetch(`http://127.0.0.1:${running.port}/ping`));
  });

  it('closes even while an event-stream style connection is open', async () => {
    const hono = new Hono();
    hono.get(
      '/hang',
      () =>
        new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const running = await startServer({ app: hono, settings: base });
    const pending = fetch(`http://127.0.0.1:${running.port}/hang`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await running.close();

    await pending.then(
      (response) => response.body?.cancel(),
      () => undefined,
    );
  });

  it('rejects when the port is taken', async () => {
    const first = await startServer({ app: app(), settings: base });

    await assert.rejects(
      startServer({ app: app(), settings: { ...base, port: first.port } }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
    );

    await first.close();
  });

  it('starts https from key and cert files through the injected factory', async () => {
    const files: Record<string, string> = { '/tls/key.pem': 'KEY', '/tls/cert.pem': 'CERT' };
    let received: HttpsServerOptions | undefined;
    const createHttpsServer = mock.fn(
      (options: HttpsServerOptions, listener: RequestListener): Server => {
        received = options;
        return http.createServer(listener);
      },
    );
    const { logger, entries } = captureLogs();

    const running = await startServer({
      app: app(),
      settings: { ...base, https: { key: '/tls/key.pem', cert: '/tls/cert.pem' } },
      logger,
      createHttpsServer,
      readFile: (path) => Promise.resolve(Buffer.from(files[path] ?? '')),
    });

    assert.ok(running.securePort && running.securePort > 0);
    assert.deepEqual(received?.key, Buffer.from('KEY'));
    assert.deepEqual(received?.cert, Buffer.from('CERT'));
    const response = await fetch(`http://127.0.0.1:${running.securePort}/ping`);
    assert.deepEqual(await response.json(), { pong: true });
    assert.ok(entries().some((entry) => entry.msg === 'https listening'));
    await running.close();
  });

  it('prefers pfx with its passphrase', async () => {
    let received: HttpsServerOptions | undefined;
    const running = await startServer({
      app: app(),
      settings: {
        ...base,
        https: { pfx: '/tls/bundle.pfx', passphrase: 'pw', key: '/x', cert: '/y' },
      },
      createHttpsServer: (options, listener) => {
        received = options;
        return http.createServer(listener);
      },
      readFile: (path) => Promise.resolve(Buffer.from(path)),
    });

    assert.deepEqual(received?.pfx, Buffer.from('/tls/bundle.pfx'));
    assert.equal(received?.passphrase, 'pw');
    await running.close();
  });

  it('warns and skips https when the material is incomplete', async () => {
    const { logger, messages } = captureLogs();
    const running = await startServer({
      app: app(),
      settings: { ...base, https: { key: '/only-key.pem' } },
      logger,
      readFile: () => Promise.resolve(Buffer.from('')),
    });

    assert.equal(running.securePort, undefined);
    assert.ok(messages().some((message) => message.includes('not starting https')));
    await running.close();
  });
});
