import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, RequestOptions } from 'node:http';
import type { Readable } from 'node:stream';

import { RequestError, RequestFailedError, RequestTimeoutError } from './errors.ts';

/**
 * A small promise-based HTTP client on top of node:http.
 *
 * It deliberately does not use fetch/undici: Sonos players reset kept-alive sockets (so both
 * agents run with keepAlive: false), UPnP needs verbs like SUBSCRIBE/UNSUBSCRIBE with headers sent
 * verbatim, and the local socket address of a response is how the discovery layer learns which
 * interface the players can reach it on.
 */

export type HttpResponseType = 'text' | 'json' | 'stream';

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string | number>;
  body?: Buffer | string;
  type?: HttpResponseType;
  timeoutMs?: number;
}

interface HttpResponseBase {
  status: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  /** The local IP address the response arrived on. */
  localAddress: string | undefined;
}

export interface HttpTextResponse extends HttpResponseBase {
  body: string;
}

export interface HttpJsonResponse<T = unknown> extends HttpResponseBase {
  body: T;
}

export interface HttpStreamResponse extends HttpResponseBase {
  /** The unread response body; the caller must consume or `resume()` it. */
  stream: Readable;
}

export type HttpResponse = HttpTextResponse | HttpJsonResponse | HttpStreamResponse;

export interface HttpClient {
  (options: HttpRequestOptions & { type: 'stream' }): Promise<HttpStreamResponse>;
  (options: HttpRequestOptions & { type: 'json' }): Promise<HttpJsonResponse>;
  (options: HttpRequestOptions & { type?: 'text' }): Promise<HttpTextResponse>;
}

/** The subset of HttpClient that callers needing only raw response streams depend on. */
export type StreamHttpClient = (
  options: HttpRequestOptions & { type: 'stream' },
) => Promise<HttpStreamResponse>;

/** What the client needs from a node:http response. */
export interface IncomingResponseLike extends Readable {
  statusCode?: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
  socket?: { localAddress?: string | undefined } | null;
}

/** What the client needs from a node:http ClientRequest. */
export interface ClientRequestLike {
  on(event: 'error', handler: (error: Error) => void): unknown;
  setTimeout(ms: number, handler: () => void): unknown;
  write(chunk: Buffer | string): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
}

/** The part of node:http / node:https the client uses; injectable for tests. */
export interface HttpTransport {
  request(
    options: RequestOptions,
    callback: (response: IncomingResponseLike) => void,
  ): ClientRequestLike;
}

export interface HttpClientDeps {
  http?: HttpTransport;
  https?: HttpTransport;
  defaultTimeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function readBody(response: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

export function createHttpClient(deps: HttpClientDeps = {}): HttpClient {
  const httpTransport: HttpTransport = deps.http ?? http;
  const httpsTransport: HttpTransport = deps.https ?? https;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const httpAgent = new http.Agent({ keepAlive: false });
  const httpsAgent = new https.Agent({ keepAlive: false });

  function request(options: HttpRequestOptions & { type: 'stream' }): Promise<HttpStreamResponse>;
  function request(options: HttpRequestOptions & { type: 'json' }): Promise<HttpJsonResponse>;
  function request(options: HttpRequestOptions & { type?: 'text' }): Promise<HttpTextResponse>;
  function request(options: HttpRequestOptions): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const url = new URL(options.url);
      const secure = url.protocol === 'https:';
      const transport = secure ? httpsTransport : httpTransport;
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

      const requestOptions: RequestOptions = {
        agent: secure ? httpsAgent : httpAgent,
        method: options.method ?? 'GET',
        host: url.hostname,
        port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
      };
      if (options.headers) {
        requestOptions.headers = options.headers;
      }

      const req = transport.request(requestOptions, (response) => {
        const status = response.statusCode ?? 0;
        const base: HttpResponseBase = {
          status,
          statusMessage: response.statusMessage ?? '',
          headers: response.headers,
          localAddress: response.socket?.localAddress,
        };

        if (status < 200 || status > 299) {
          readBody(response)
            .then((body) => {
              reject(
                new RequestFailedError(
                  options.url,
                  status,
                  base.statusMessage,
                  body.toString('utf8'),
                ),
              );
            })
            .catch(reject);
          return;
        }

        if (options.type === 'stream') {
          resolve({ ...base, stream: response });
          return;
        }

        readBody(response)
          .then((buffer) => {
            const text = buffer.toString('utf8');
            if (options.type === 'json') {
              try {
                resolve({ ...base, body: JSON.parse(text) as unknown });
              } catch (error) {
                reject(
                  new RequestError(`Invalid JSON in response from ${options.url}`, {
                    cause: error,
                  }),
                );
              }
              return;
            }

            resolve({ ...base, body: text });
          })
          .catch(reject);
      });

      req.on('error', (error) => {
        reject(
          error instanceof RequestError
            ? error
            : new RequestError(`Request to ${options.url} failed: ${error.message}`, {
                cause: error,
              }),
        );
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new RequestTimeoutError(options.url, timeoutMs));
      });

      if (options.body !== undefined) {
        req.write(options.body);
      }

      req.end();
    });
  }

  return request;
}
