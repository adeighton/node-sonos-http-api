import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, RequestOptions, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';

import { RequestError, RequestFailedError, RequestTimeoutError } from './errors.ts';
import { DEFAULT_TIMEOUT_MS, createHttpClient } from './http.ts';
import type { HttpTransport, IncomingResponseLike } from './http.ts';

type ResponseCallback = (response: IncomingResponseLike) => void;

interface FakeResponseOptions {
  statusCode?: number;
  statusMessage?: string;
  headers?: IncomingHttpHeaders;
}

/** A fake node:http transport that records the request and lets the test drive the response. */
function fakeTransport() {
  const handlers = new Map<string, (error: Error) => void>();
  let responseCallback: ResponseCallback | undefined;

  const client = {
    on: mock.fn((event: string, handler: (error: Error) => void) => {
      handlers.set(event, handler);
      return client;
    }),
    end: mock.fn(() => client),
    write: mock.fn((_chunk: Buffer | string) => true),
    setTimeout: mock.fn((_ms: number, handler: () => void) => {
      handlers.set('timeout', handler);
      return client;
    }),
    destroy: mock.fn((error?: Error) => {
      handlers.get('error')?.(error ?? new Error('destroyed'));
      return client;
    }),
  };

  const request = mock.fn((_options: RequestOptions, callback: ResponseCallback) => {
    responseCallback = callback;
    return client;
  });

  const transport: HttpTransport = { request };

  function fakeResponse(options: FakeResponseOptions = {}): IncomingResponseLike {
    return Object.assign(new Readable({ read() {} }), {
      statusCode: options.statusCode ?? 200,
      statusMessage: options.statusMessage ?? 'OK',
      headers: options.headers ?? {},
      socket: { localAddress: '127.0.0.2' },
    });
  }

  return {
    transport,
    request,
    client,
    fakeResponse,
    respond(response: IncomingResponseLike) {
      assert.ok(responseCallback, 'request() was not called');
      responseCallback(response);
    },
    emit(event: string, error: Error = new Error(event)) {
      const handler = handlers.get(event);
      assert.ok(handler, `no handler registered for ${event}`);
      handler(error);
    },
    requestOptions(): Omit<RequestOptions, 'agent'> {
      const options = request.mock.calls[0]?.arguments[0];
      assert.ok(options, 'request() was not called');
      const { agent: _agent, ...rest } = options;
      return rest;
    },
  };
}

describe('httpRequest with a fake transport', () => {
  it('transfers common arguments to http.request', () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });

    void httpRequest({
      url: 'http://127.0.0.1:1400/path',
      method: 'SUBSCRIBE',
      headers: { 'Content-Type': 'text/xml' },
    }).catch(() => undefined);

    assert.equal(fake.request.mock.callCount(), 1);
    assert.deepEqual(fake.requestOptions(), {
      method: 'SUBSCRIBE',
      path: '/path',
      host: '127.0.0.1',
      port: 1400,
      headers: { 'Content-Type': 'text/xml' },
    });
  });

  it('uses https (and port 443) for https urls', () => {
    const plain = fakeTransport();
    const secure = fakeTransport();
    const httpRequest = createHttpClient({ http: plain.transport, https: secure.transport });

    void httpRequest({ url: 'https://127.0.0.1/path', method: 'SUBSCRIBE' }).catch(() => undefined);

    assert.equal(plain.request.mock.callCount(), 0);
    assert.equal(secure.request.mock.callCount(), 1);
    assert.deepEqual(secure.requestOptions(), {
      method: 'SUBSCRIBE',
      path: '/path',
      host: '127.0.0.1',
      port: 443,
    });
  });

  it('defaults to GET, port 80, the default timeout and keeps the query string', () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });

    void httpRequest({ url: 'http://127.0.0.1/path?a=1' }).catch(() => undefined);

    assert.deepEqual(fake.requestOptions(), {
      method: 'GET',
      path: '/path?a=1',
      host: '127.0.0.1',
      port: 80,
    });
    assert.equal(fake.client.setTimeout.mock.calls[0]?.arguments[0], DEFAULT_TIMEOUT_MS);
    assert.equal(fake.client.end.mock.callCount(), 1, 'end() triggers the request');
  });

  it('applies a custom timeout and writes the body', () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport, defaultTimeoutMs: 500 });

    void httpRequest({ url: 'http://127.0.0.1/path', body: 'FOOBAR', timeoutMs: 10 }).catch(
      () => undefined,
    );

    assert.equal(fake.client.setTimeout.mock.calls[0]?.arguments[0], 10);
    assert.equal(fake.client.write.mock.calls[0]?.arguments[0], 'FOOBAR');
  });

  it('resolves with the text body and the local address', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path' });

    const response = fake.fakeResponse();
    fake.respond(response);
    response.push('abc');
    response.push('def');
    response.push(null);

    const result = await promise;
    assert.equal(result.body, 'abcdef');
    assert.equal(result.status, 200);
    assert.equal(result.localAddress, '127.0.0.2');
  });

  it('resolves with parsed JSON when type is json', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path', type: 'json' });

    const response = fake.fakeResponse();
    fake.respond(response);
    response.push('{ "x": 1, "y": "z" }');
    response.push(null);

    assert.deepEqual((await promise).body, { x: 1, y: 'z' });
  });

  it('rejects (instead of throwing) on invalid JSON', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path', type: 'json' });

    const response = fake.fakeResponse();
    fake.respond(response);
    response.push('not json');
    response.push(null);

    await assert.rejects(promise, RequestError);
  });

  it('returns the unread response stream when type is stream', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path', type: 'stream' });

    const response = fake.fakeResponse({ headers: { sid: 'uuid:1' } });
    fake.respond(response);

    const result = await promise;
    assert.equal(result.stream, response);
    assert.equal(result.headers.sid, 'uuid:1');
  });

  it('rejects when the request errors', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path' });

    fake.emit('error', new Error('ECONNRESET'));

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.match(error.message, /ECONNRESET/);
      return true;
    });
  });

  it('rejects with a RequestFailedError carrying status and body for non-2xx responses', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path' });

    const response = fake.fakeResponse({ statusCode: 500, statusMessage: 'This is an error' });
    fake.respond(response);
    response.push('<fault/>');
    response.push(null);

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof RequestFailedError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.statusMessage, 'This is an error');
      assert.equal(error.body, '<fault/>');
      return true;
    });
  });

  it('destroys the request and rejects with a RequestTimeoutError on timeout', async () => {
    const fake = fakeTransport();
    const httpRequest = createHttpClient({ http: fake.transport });
    const promise = httpRequest({ url: 'http://127.0.0.1/path', timeoutMs: 25 });

    fake.emit('timeout');

    assert.equal(fake.client.destroy.mock.callCount(), 1);
    await assert.rejects(promise, RequestTimeoutError);
  });
});

describe('httpRequest against a loopback server', () => {
  let server: Server;
  let baseUrl: string;
  let connections = 0;

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      switch (url.pathname) {
        case '/text':
          res.end('hello');
          return;
        case '/utf8': {
          const bytes = Buffer.from('é');
          res.write(bytes.subarray(0, 1));
          setTimeout(() => res.end(bytes.subarray(1)), 5);
          return;
        }
        case '/json':
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, method: req.method }));
          return;
        case '/fail':
          res.statusCode = 503;
          res.statusMessage = 'Nope';
          res.end('busy');
          return;
        case '/slow':
          // Never respond; the client must time out.
          return;
        default:
          res.statusCode = 404;
          res.end();
      }
    });
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('round-trips text and reports the local address', async () => {
    const httpRequest = createHttpClient();
    const response = await httpRequest({ url: `${baseUrl}/text` });

    assert.equal(response.body, 'hello');
    assert.equal(response.localAddress, '127.0.0.1');
  });

  it('reassembles multi-byte characters split across chunks', async () => {
    const httpRequest = createHttpClient();
    const response = await httpRequest({ url: `${baseUrl}/utf8` });

    assert.equal(response.body, 'é');
  });

  it('parses JSON and sends non-standard methods verbatim', async () => {
    const httpRequest = createHttpClient();
    const response = await httpRequest({
      url: `${baseUrl}/json`,
      method: 'SUBSCRIBE',
      type: 'json',
    });

    assert.deepEqual(response.body, { ok: true, method: 'SUBSCRIBE' });
  });

  it('opens a fresh connection for every request (no keep-alive)', async () => {
    const httpRequest = createHttpClient();
    const before = connections;

    await httpRequest({ url: `${baseUrl}/text` });
    await httpRequest({ url: `${baseUrl}/text` });

    assert.equal(connections - before, 2);
  });

  it('rejects non-2xx responses with the body attached', async () => {
    const httpRequest = createHttpClient();

    await assert.rejects(httpRequest({ url: `${baseUrl}/fail` }), (error: unknown) => {
      assert.ok(error instanceof RequestFailedError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.body, 'busy');
      return true;
    });
  });

  it('times out and releases the socket', async () => {
    const httpRequest = createHttpClient();

    await assert.rejects(
      httpRequest({ url: `${baseUrl}/slow`, timeoutMs: 50 }),
      RequestTimeoutError,
    );
  });
});
