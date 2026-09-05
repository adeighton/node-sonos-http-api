import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HTTPException } from 'hono/http-exception';

import { ArgumentError, UnknownServiceError } from '../discovery/errors.ts';
import {
  BadRequestError,
  HttpError,
  NotFoundError,
  ServiceUnavailableError,
  errorBody,
  errorMessage,
  statusForError,
} from './errors.ts';

describe('http errors', () => {
  it('carry their status and name', () => {
    assert.equal(new BadRequestError('bad').status, 400);
    assert.equal(new NotFoundError('missing').status, 404);
    assert.equal(new ServiceUnavailableError('later').status, 503);
    assert.equal(new HttpError(418, 'teapot').name, 'HttpError');
    assert.equal(new NotFoundError('x').name, 'NotFoundError');
    assert.ok(new BadRequestError('x') instanceof HttpError);
  });

  it('map thrown values to status codes', () => {
    assert.equal(statusForError(new NotFoundError('x')), 404);
    assert.equal(statusForError(new ArgumentError('x')), 400);
    assert.equal(statusForError(new UnknownServiceError('Tidal')), 400);
    assert.equal(statusForError(new URIError('URI malformed')), 400);
    assert.equal(statusForError(new RangeError('too loud')), 400);
    assert.equal(statusForError(new HTTPException(401, { message: 'Unauthorized' })), 401);
    assert.equal(statusForError(new Error('boom')), 500);
    assert.equal(statusForError('string'), 500);
  });

  it('produce a stack-free body from errors, strings and unknown values', () => {
    assert.deepEqual(errorBody(new Error('boom')), { status: 'error', error: 'boom' });
    assert.deepEqual(errorBody('plain'), { status: 'error', error: 'plain' });
    assert.deepEqual(errorBody(42), { status: 'error', error: 'Unknown error' });
    assert.equal(errorMessage(undefined), 'Unknown error');
    assert.ok(!('stack' in errorBody(new Error('boom'))));
  });
});
