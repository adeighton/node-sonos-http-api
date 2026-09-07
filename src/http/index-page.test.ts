import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActionRegistry } from '../actions/registry.ts';
import { escapeHtml, renderIndexHtml } from './index-page.ts';

describe('renderIndexHtml', () => {
  it('lists every action with aliases and usage, and the discovered rooms', () => {
    const registry = new ActionRegistry();
    registry.register('volume', () => Promise.resolve(), {
      usage: '/{room}/volume/{0-100}',
      description: 'Set volume',
    });
    registry.register(
      'favorite',
      () => Promise.resolve(),
      { usage: '/favorite/{name}', description: 'Play <a favorite>' },
      ['favourite'],
    );

    const html = renderIndexHtml({
      registry,
      version: '2.0.0',
      roomNames: ['1. Kitchen', 'Office & Den'],
    });

    assert.ok(html.includes('v2.0.0'));
    assert.ok(html.includes('<code>favorite</code>'));
    assert.ok(html.includes('also <code>favourite</code>'));
    assert.ok(html.includes('/{room}/volume/{0-100}'));
    assert.ok(html.includes('Play &lt;a favorite&gt;'), 'descriptions are escaped');
    assert.ok(html.includes('href="/1.%20Kitchen/state"'));
    assert.ok(html.includes('Office &amp; Den'));
    assert.ok(
      html.indexOf('<code>favorite</code>') < html.indexOf('<code>volume</code>'),
      'sorted by name',
    );
  });

  it('lists the endpoints that are not actions, linking the ones a browser can open', () => {
    const html = renderIndexHtml({
      registry: new ActionRegistry(),
      version: '2.0.0',
      roomNames: [],
    });

    assert.ok(html.includes('<a href="/voices"><code>/voices</code></a>'));
    assert.ok(html.includes('<a href="/health"><code>/health</code></a>'));
    assert.ok(html.includes('<a href="/events"><code>/events</code></a>'));
    assert.ok(html.includes('<code>POST</code>'), 'POST /announce is listed');
    assert.ok(
      !html.includes('<a href="/announce/{id}">'),
      'a path with a placeholder is not a link',
    );
  });

  it('explains when no players are known yet', () => {
    const html = renderIndexHtml({ registry: new ActionRegistry(), version: 'x', roomNames: [] });
    assert.ok(html.includes('No players discovered yet'));
  });

  it('escapes html special characters', () => {
    assert.equal(
      escapeHtml(`<a href="x">&'</a>`),
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });
});
