import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ArgumentError,
  RequestError,
  RequestFailedError,
  RequestTimeoutError,
  UnknownServiceError,
} from './errors.ts';

describe('discovery errors', () => {
  it('ArgumentError carries its name and message', () => {
    const error = new ArgumentError('bad input');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ArgumentError');
    assert.equal(error.message, 'bad input');
  });

  it('UnknownServiceError remembers the service name', () => {
    const error = new UnknownServiceError('Tidal');
    assert.equal(error.name, 'UnknownServiceError');
    assert.equal(error.serviceName, 'Tidal');
    assert.match(error.message, /Tidal/);
  });

  it('request errors form a hierarchy', () => {
    const timeout = new RequestTimeoutError('http://192.168.1.1:1400/x', 10);
    const failed = new RequestFailedError('http://192.168.1.1:1400/x', 500, 'Boom', '<fault/>');

    assert.ok(timeout instanceof RequestError);
    assert.ok(failed instanceof RequestError);
    assert.equal(timeout.name, 'RequestTimeoutError');
    assert.match(timeout.message, /timed out after 10 ms/);
    assert.equal(failed.name, 'RequestFailedError');
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.statusMessage, 'Boom');
    assert.equal(failed.body, '<fault/>');
    assert.match(failed.message, /Got status 500/);
  });

  it('RequestError supports a cause', () => {
    const cause = new Error('socket hang up');
    const error = new RequestError('wrapped', { cause });
    assert.equal(error.cause, cause);
  });
});
