import { Readable } from 'node:stream';
import { mock } from 'node:test';

import type { HttpStreamResponse } from '../discovery/http.ts';
import { parseSoapResponse } from '../discovery/soap.ts';
import type { SoapAction, SoapClient, SoapValues } from '../discovery/soap.ts';

export interface RecordedSoapCall {
  url: string;
  action: SoapAction;
  values: SoapValues | undefined;
}

export interface FakeSoapClient extends SoapClient {
  /** Every invoke() so far, in order. */
  calls: RecordedSoapCall[];
  /** Makes the next invoke() resolve with this body (typically a fixture stream). */
  queueResponse(stream: Readable): void;
  /** Makes the next invoke() reject. */
  queueFailure(error: Error): void;
  /** Convenience for `calls.map(c => [url, action, values])` style assertions. */
  callArgs(index: number): [string, SoapAction, SoapValues | undefined];
}

export function streamResponse(stream: Readable = Readable.from([])): HttpStreamResponse {
  return {
    status: 200,
    statusMessage: 'OK',
    headers: {},
    localAddress: '127.0.0.1',
    stream,
  };
}

/**
 * A SoapClient for tests: records every invoke, answers with an empty body unless a response
 * was queued, and parses responses with the real parser so fixture streams behave as in production.
 */
export function fakeSoapClient(): FakeSoapClient {
  const calls: RecordedSoapCall[] = [];
  const queue: Array<Readable | Error> = [];

  const invoke = mock.fn((url: string, action: SoapAction, values?: SoapValues) => {
    calls.push({ url, action, values });
    const next = queue.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }

    return Promise.resolve(streamResponse(next ?? Readable.from([])));
  });

  return {
    calls,
    invoke,
    parse: parseSoapResponse,
    queueResponse: (stream) => {
      queue.push(stream);
    },
    queueFailure: (error) => {
      queue.push(error);
    },
    callArgs: (index) => {
      const call = calls[index];
      if (!call) {
        throw new Error(`no soap call at index ${index} (${calls.length} recorded)`);
      }

      return [call.url, call.action, call.values];
    },
  };
}
