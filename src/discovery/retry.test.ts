import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { RequestFailedError, RequestTimeoutError, SoapFaultError } from './errors.ts';
import { isTransientFault, withTransientRetry } from './retry.ts';

function failingThen<T>(failures: Error[], value: T) {
  let calls = 0;
  return mock.fn(() => {
    const failure = failures[calls];
    calls += 1;
    return failure ? Promise.reject(failure) : Promise.resolve(value);
  });
}

describe('withTransientRetry', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('returns the first successful result without waiting', async () => {
    const fn = failingThen([], 'ok');
    assert.equal(await withTransientRetry(fn, { label: 'Play' }), 'ok');
    assert.equal(fn.mock.callCount(), 1);
  });

  it('retries once after a timeout, with a backoff, and logs it', async () => {
    const logs = captureLogs();
    const fn = failingThen([new RequestTimeoutError('http://p', 10_000)], 'ok');

    const pending = withTransientRetry(fn, { label: 'Play', backoffMs: 300, logger: logs.logger });
    await flushPromises();
    assert.equal(fn.mock.callCount(), 1, 'waits for the backoff before retrying');
    mock.timers.tick(300);
    await flushPromises();

    assert.equal(await pending, 'ok');
    assert.equal(fn.mock.callCount(), 2);
    assert.ok(logs.messages().some((message) => message.includes('retrying')));
  });

  it('gives up after the configured attempts and rethrows the last error', async () => {
    const errors = [
      new RequestTimeoutError('http://p', 10_000),
      new RequestTimeoutError('http://p', 10_000),
    ];
    const fn = failingThen(errors, 'never');

    const pending = withTransientRetry(fn, { label: 'Play', attempts: 2, backoffMs: 100 });
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await flushPromises();
    mock.timers.tick(100);
    await flushPromises();

    assert.equal(await outcome, errors[1]);
    assert.equal(fn.mock.callCount(), 2);
  });

  it('does not retry errors that are not transient', async () => {
    const refusal = new SoapFaultError('http://p', 'Seek', 711, 'Illegal seek target', '');
    const fn = failingThen([refusal], 'never');
    await assert.rejects(withTransientRetry(fn, { label: 'Seek' }), refusal);
    assert.equal(fn.mock.callCount(), 1);

    const bad = failingThen([new Error('bug')], 'never');
    await assert.rejects(withTransientRetry(bad, { label: 'Seek' }), /bug/);
    assert.equal(bad.mock.callCount(), 1);
  });

  it('accepts a custom predicate for what counts as transient', async () => {
    const notReady = new SoapFaultError('http://p', 'Play', 701, 'Transition not available', '');
    const fn = failingThen([notReady], 'ok');

    const pending = withTransientRetry(fn, {
      label: 'Play',
      backoffMs: 1000,
      retryOn: (error) => error instanceof SoapFaultError && error.errorCode === 701,
    });
    await flushPromises();
    mock.timers.tick(1000);
    await flushPromises();

    assert.equal(await pending, 'ok');
    assert.equal(fn.mock.callCount(), 2);
  });
});

describe('isTransientFault', () => {
  it('is true for timeouts and gateway failures without a UPnP fault', () => {
    assert.equal(isTransientFault(new RequestTimeoutError('u', 1)), true);
    assert.equal(
      isTransientFault(new RequestFailedError('u', 500, 'Internal Server Error', '')),
      true,
    );
    assert.equal(isTransientFault(new RequestFailedError('u', 503, 'Busy', '')), true);
  });

  it('is false for refusals, client errors and ordinary errors', () => {
    assert.equal(isTransientFault(new SoapFaultError('u', 'Play', 701, 'nope', '')), false);
    assert.equal(isTransientFault(new RequestFailedError('u', 404, 'Not Found', '')), false);
    assert.equal(isTransientFault(new Error('bug')), false);
  });
});
