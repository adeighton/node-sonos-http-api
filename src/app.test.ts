import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createApp } from './app.ts';
import { SoapFaultError } from './discovery/errors.ts';
import type { AppDeps } from './app.ts';
import { ActionRegistry } from './actions/registry.ts';
import { settingsSchema } from './config/schema.ts';
import type { Settings } from './config/schema.ts';
import { EventHub } from './http/events.ts';
import { PresetStore } from './presets/store.ts';
import { captureLogs } from './testing/capture-logs.ts';
import { FakeSystem } from './testing/fake-system.ts';
import { createTestPlayer } from './testing/test-player.ts';
import { withTempDir } from './testing/with-temp-dir.ts';

interface TestAppOptions {
  settings?: Partial<Settings>;
  rooms?: string[];
}

function testApp(webroot: string, options: TestAppOptions = {}) {
  const system = new FakeSystem();
  for (const [index, room] of (options.rooms ?? ['1. Kitchen', 'Office']).entries()) {
    const { player } = createTestPlayer({ system, roomName: room, uuid: `RINCON_${index}` });
    system.addStandalone(player);
  }

  const settings: Settings = { ...settingsSchema.parse({}), webroot, ...options.settings };
  const registry = new ActionRegistry();
  registry.register(
    'zones',
    (context) => Promise.resolve(context.system.zones.map((z) => z.coordinator.roomName)),
    {
      usage: '/zones',
      description: 'zones',
    },
  );
  registry.register(
    'echo',
    (context, values) =>
      Promise.resolve({ room: context.player.roomName, values, base: context.publicBaseUrl }),
    { usage: '/{room}/echo/{values...}', description: 'echo' },
  );
  registry.register('nothing', () => Promise.resolve(), { usage: '/nothing', description: '' });
  registry.register('boom', () => Promise.reject(new Error('kaboom')), {
    usage: '/boom',
    description: '',
  });
  registry.register(
    'refused',
    () =>
      Promise.reject(
        new SoapFaultError('http://192.168.1.5:1400/x', 'Seek', 711, 'Illegal seek target', ''),
      ),
    { usage: '/refused', description: '' },
  );
  registry.register('loud', () => Promise.reject(new RangeError('too loud')), {
    usage: '/loud',
    description: '',
  });

  const { logger, entries } = captureLogs();
  const hub = new EventHub({ logger });
  const deps: AppDeps = {
    system,
    settings,
    registry,
    presets: new PresetStore(join(webroot, 'presets'), { logger }),
    tts: { providers: [], speak: () => Promise.reject(new Error('no tts in this test')) },
    clips: { get: () => Promise.reject(new Error('no clips in this test')) },
    announcer: { announce: () => Promise.resolve() },
    hub,
    logger,
    version: '2.0.0-test',
    publicBaseUrl: () => `http://${system.localEndpoint}:${settings.port}`,
  };
  return { app: createApp(deps), system, hub, entries, settings };
}

async function withWebroot<T>(fn: (webroot: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    await mkdir(join(dir, 'tts'));
    await mkdir(join(dir, 'clips'));
    await writeFile(join(dir, 'tts', 'hello.mp3'), Buffer.from('ID3fake-mp3-bytes-0123456789'));
    await writeFile(join(dir, 'clips', 'ding.mp3'), Buffer.from('ID3ding'));
    await writeFile(join(dir, 'sonos-icon.png'), Buffer.from('PNG'));
    return fn(dir);
  });
}

describe('createApp', () => {
  it('serves the generated index and a 204 favicon', async () => {
    await withWebroot(async (webroot) => {
      const { app } = testApp(webroot);

      const index = await app.request('/');
      assert.equal(index.status, 200);
      const html = await index.text();
      assert.ok(html.includes('v2.0.0-test'));
      assert.ok(html.includes('1.%20Kitchen'));
      assert.ok(html.includes('<code>echo</code>'));

      assert.equal((await app.request('/favicon.ico')).status, 204);
    });
  });

  it('dispatches room and room-less actions and normalizes empty results', async () => {
    await withWebroot(async (webroot) => {
      const { app } = testApp(webroot);

      const named = await app.request('/1.%20kitchen/echo/a%2Fb/50%25');
      assert.equal(named.status, 200);
      assert.deepEqual(await named.json(), {
        room: '1. Kitchen',
        values: ['a/b', '50%'],
        base: 'http://127.0.0.1:5005',
      });

      const anyRoom = await app.request('/zones');
      assert.deepEqual(await anyRoom.json(), ['1. Kitchen', 'Office']);

      const nothing = await app.request('/Office/nothing');
      assert.deepEqual(await nothing.json(), { status: 'success' });
    });
  });

  it('maps errors to statuses with stack-free JSON bodies', async () => {
    await withWebroot(async (webroot) => {
      const { app, entries } = testApp(webroot);

      const notFound = await app.request('/nope');
      assert.equal(notFound.status, 404);
      assert.deepEqual(await notFound.json(), {
        status: 'error',
        error: "Action 'nope' not found",
      });

      const badEscape = await app.request('/say/100%');
      assert.equal(badEscape.status, 400);

      const range = await app.request('/loud');
      assert.equal(range.status, 400);
      assert.deepEqual(await range.json(), { status: 'error', error: 'too loud' });

      const refused = await app.request('/1.%20Kitchen/refused');
      assert.equal(refused.status, 502);
      assert.deepEqual(await refused.json(), {
        status: 'error',
        error: 'Seek was rejected by the player: UPnP error 711 (Illegal seek target)',
      });
      const refusedLog = entries().find(
        (entry) => entry.msg === 'request failed' && entry.status === 502,
      );
      assert.ok(refusedLog);
      assert.equal(refusedLog.method, 'GET');
      assert.equal(refusedLog.path, '/1. Kitchen/refused');
      const err = refusedLog.err as Record<string, unknown>;
      assert.equal(err.type, 'SoapFaultError');
      assert.equal(err.errorCode, 711);
      assert.equal(err.action, 'Seek');
      assert.equal(err.url, 'http://192.168.1.5:1400/x');

      const failure = await app.request('/boom');
      assert.equal(failure.status, 500);
      const body = (await failure.json()) as Record<string, unknown>;
      assert.deepEqual(body, { status: 'error', error: 'kaboom' });
      assert.ok(entries().some((entry) => entry.msg === 'request failed' && entry.status === 500));
    });
  });

  it('answers 503 before discovery and 405 for non-GET methods', async () => {
    await withWebroot(async (webroot) => {
      const { app } = testApp(webroot, { rooms: [] });

      const early = await app.request('/zones');
      assert.equal(early.status, 503);
      assert.match(((await early.json()) as { error: string }).error, /No Sonos system/);

      const post = await app.request('/zones', { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET');
      assert.equal((await app.request('/', { method: 'DELETE' })).status, 405);
    });
  });

  it('serves media without auth, with byte ranges, and 404s missing clips', async () => {
    await withWebroot(async (webroot) => {
      const { app } = testApp(webroot, { settings: { auth: { username: 'u', password: 'p' } } });

      const clip = await app.request('/tts/hello.mp3');
      assert.equal(clip.status, 200);
      assert.equal((await clip.arrayBuffer()).byteLength, 28);

      const range = await app.request('/clips/ding.mp3', { headers: { range: 'bytes=0-2' } });
      assert.equal(range.status, 206);
      assert.equal(await range.text(), 'ID3');

      assert.equal((await app.request('/sonos-icon.png')).status, 200);

      const missing = await app.request('/tts/missing.mp3');
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { status: 'error', error: 'No such clip' });

      const traversal = await app.request('/tts/..%2F..%2Fpackage.json');
      assert.notEqual(traversal.status, 200);
    });
  });

  it('enforces basic auth on the API when configured, but not on preflight', async () => {
    await withWebroot(async (webroot) => {
      const { app } = testApp(webroot, {
        settings: { auth: { username: 'admin', password: 'secret' } },
      });

      const denied = await app.request('/zones');
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="Access Denied"');

      const wrong = await app.request('/zones', {
        headers: { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` },
      });
      assert.equal(wrong.status, 401);

      const allowed = await app.request('/zones', {
        headers: { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), '*');

      const preflight = await app.request('/zones', {
        method: 'OPTIONS',
        headers: { origin: 'http://app', 'access-control-request-method': 'GET' },
      });
      assert.equal(preflight.status, 204);
    });
  });

  it('streams system events to /events clients', async () => {
    await withWebroot(async (webroot) => {
      const { app, hub } = testApp(webroot);

      const response = await app.request('/events');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const deadline = Date.now() + 2000;
      while (hub.size === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(hub.size, 1);

      hub.broadcast('{"type":"volume-change","data":{"newVolume":7}}');
      const { value } = await reader.read();
      assert.equal(
        new TextDecoder().decode(value),
        'data: {"type":"volume-change","data":{"newVolume":7}}\n\n',
      );
      await reader.cancel();
    });
  });
});
