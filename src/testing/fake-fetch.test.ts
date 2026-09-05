import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeFetch } from './fake-fetch.ts';

describe('fakeFetch', () => {
  it('serves JSON bodies for exact routes and records the call', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.example.com/token': { body: { token: 'abc' } },
    });

    const response = await fetch('https://api.example.com/token', { method: 'POST' });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), { token: 'abc' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.example.com/token');
    assert.equal(calls[0]?.init?.method, 'POST');
  });

  it('matches prefix routes, text bodies and custom status codes', async () => {
    const { fetch } = fakeFetch({
      'https://api.example.com/search*': { status: 404, body: 'nothing here' },
    });

    const response = await fetch(new URL('https://api.example.com/search?q=x'));

    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'nothing here');
  });

  it('supports function routes that see the url and init', async () => {
    const { fetch } = fakeFetch({
      'https://api.example.com/echo': (url, init) => ({
        body: { url, method: init?.method ?? 'GET' },
      }),
    });

    const response = await fetch('https://api.example.com/echo', { method: 'PUT' });

    assert.deepEqual(await response.json(), {
      url: 'https://api.example.com/echo',
      method: 'PUT',
    });
  });

  it('rejects unknown urls instead of hitting the network', async () => {
    const { fetch } = fakeFetch({});

    await assert.rejects(
      fetch('https://example.com/unknown'),
      /no route for https:\/\/example.com\/unknown/,
    );
  });
});
