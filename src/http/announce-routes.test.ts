import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ActionRegistry } from '../actions/registry.ts';
import type { AnnouncementTransition } from '../announce/types.ts';
import { createApp } from '../app.ts';
import { settingsSchema } from '../config/schema.ts';
import { AnnouncementHistory } from '../history/sqlite.ts';
import { silentLogger } from '../logger.ts';
import { PresetStore } from '../presets/store.ts';
import { createActionContext } from '../testing/action-context.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { BadRequestError } from './errors.ts';
import { EventHub } from './events.ts';

/** The whole app, so the routes are exercised behind the real middleware and error mapping. */
async function setup(presetDir?: string) {
  const { context, announcer, spoken, system } = createActionContext({
    rooms: ['Kitchen', 'Office'],
  });
  const presets = new PresetStore(presetDir ?? '/nonexistent');
  if (presetDir) {
    await presets.load();
  }
  const history = AnnouncementHistory.open(':memory:');
  const app = createApp({
    system,
    settings: settingsSchema.parse({ announce: { idempotencyWindowMs: 60_000 } }),
    registry: new ActionRegistry(),
    presets,
    tts: context.tts,
    clips: context.clips,
    announcer,
    history,
    hub: new EventHub({ logger: silentLogger }),
    logger: silentLogger,
    version: 'test',
    publicBaseUrl: () => 'http://127.0.0.1:5005',
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const queued = (id: string, extra: Partial<AnnouncementTransition> = {}) =>
    history.record({
      id,
      state: 'queued',
      previousState: undefined,
      source: 'api',
      priority: 'normal',
      target: 'all',
      at: Date.now(),
      ...extra,
    });
  return { app, post, announcer, spoken, history, queued, system };
}

describe('POST /announce', () => {
  it('queues speech for rooms and answers 202 with the id and a Location', async () => {
    const { post, announcer, spoken } = await setup();

    const response = await post('/announce', {
      text: 'Good morning',
      target: { rooms: ['kitchen', { name: 'Office', volume: 20 }] },
      volume: 35,
      voice: 'Amy',
      engine: 'standard',
      priority: 'urgent',
      pauseOthers: true,
    });

    assert.equal(response.status, 202);
    const body = (await response.json()) as { id: string; state: string; priority: string };
    assert.equal(body.state, 'queued');
    assert.equal(body.priority, 'urgent');
    assert.equal(response.headers.get('Location'), `/announce/${body.id}`);
    const [spec] = announcer.calls;
    assert.ok(spec);
    assert.equal(spec.target.kind, 'rooms');
    assert.deepEqual(
      spec.target.kind === 'rooms' &&
        spec.target.rooms.map((room) => [room.player.roomName, room.volume]),
      [
        ['Kitchen', undefined],
        ['Office', 20],
      ],
    );
    assert.equal(spec.volume, 35);
    assert.equal(spec.priority, 'urgent');
    assert.equal(spec.pauseOthers, true);
    assert.equal(spec.source, 'api');
    assert.equal(spec.textPreview, 'Good morning');
    assert.equal(spec.requestId, response.headers.get('X-Request-Id'));
    assert.equal(spoken.length, 0, 'synthesis waits for the scheduler');
    assert.equal((await spec.prepare()).uri, 'http://127.0.0.1:5005/tts/Good%20morning.mp3');
    assert.deepEqual(spoken, [{ phrase: 'Good morning', voice: 'Amy' }]);
  });

  it('waits for the result when asked, and passes failures through', async () => {
    const { post, announcer } = await setup();

    const done = await post('/announce', { clip: 'ding.mp3', target: 'all', wait: true });
    assert.equal(done.status, 200);
    const body = (await done.json()) as { status: string; announcement: { state: string } };
    assert.equal(body.status, 'success');
    assert.equal(body.announcement.state, 'done');
    assert.equal(announcer.calls[0]?.textPreview, 'ding.mp3');

    announcer.failure = new BadRequestError('no such voice');
    const failed = await post('/announce', { text: 'x', target: 'all', wait: true });
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { status: 'error', error: 'no such voice' });
  });

  it('resolves presets and ssml, and 404s unknown presets, rooms and clips', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'doorbell.json'), '{"players":[{"roomName":"Kitchen"}]}');
      const { post, announcer } = await setup(dir);

      const ok = await post('/announce', {
        ssml: '<speak>Ding</speak>',
        target: { preset: 'doorbell' },
      });
      assert.equal(ok.status, 202);
      const [spec] = announcer.calls;
      assert.equal(spec?.target.kind === 'preset' && spec.target.name, 'doorbell');
      assert.equal(spec?.textPreview, '<speak>Ding</speak>');

      assert.equal(
        (await post('/announce', { text: 'x', target: { preset: 'nope' } })).status,
        404,
      );
      assert.equal((await post('/announce', { text: 'x', target: ['Attic'] })).status, 404);
      assert.equal(announcer.calls.length, 1, 'nothing was queued for the bad targets');
    });
  });

  it('rejects bad bodies with 400 and too large ones with 413', async () => {
    const { post, app } = await setup();
    assert.equal((await post('/announce', { target: 'all' })).status, 400);
    assert.equal((await post('/announce', 'not json')).status, 400);
    const notJson = await app.request('/announce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(notJson.status, 400);
    const huge = await post('/announce', { text: 'x'.repeat(70_000), target: 'all' });
    assert.equal(huge.status, 413);
  });

  it('replays an announcement submitted with the same idempotency key inside the window', async () => {
    const { post, announcer, queued } = await setup();
    queued('earlier', { idempotencyKey: 'briefing-2026-09-07', at: Date.now() - 1000 });
    queued('ancient', { idempotencyKey: 'old-key', at: Date.now() - 120_000 });

    const replayed = await post('/announce', {
      text: 'x',
      target: 'all',
      idempotencyKey: 'briefing-2026-09-07',
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.headers.get('Idempotent-Replayed'), 'true');
    assert.equal(((await replayed.json()) as { id: string }).id, 'earlier');
    assert.equal(announcer.calls.length, 0);

    const byHeader = await post(
      '/announce',
      { text: 'x', target: 'all' },
      { 'Idempotency-Key': 'briefing-2026-09-07' },
    );
    assert.equal(byHeader.status, 200);

    const expired = await post('/announce', {
      text: 'x',
      target: 'all',
      idempotencyKey: 'old-key',
    });
    assert.equal(expired.status, 202, 'outside the window it plays again');
    assert.equal(announcer.calls[0]?.idempotencyKey, 'old-key');
  });
});

describe('GET and DELETE /announce', () => {
  it('lists and reads the history', async () => {
    const { app, queued } = await setup();
    queued('a1', { at: 1000 });
    queued('a2', { at: 2000, textPreview: 'Hello' });

    const list = (await (await app.request('/announce?limit=1')).json()) as Array<{ id: string }>;
    assert.deepEqual(
      list.map((entry) => entry.id),
      ['a2'],
    );
    const all = (await (await app.request('/announce')).json()) as Array<{ id: string }>;
    assert.equal(all.length, 2);
    const filtered = (await (await app.request('/announce?state=done')).json()) as unknown[];
    assert.equal(filtered.length, 0);
    assert.equal((await app.request('/announce?state=bogus')).status, 400);
    assert.equal((await app.request('/announce?limit=0')).status, 400);

    const one = await app.request('/announce/a2');
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as { textPreview: string }).textPreview, 'Hello');
    assert.equal((await app.request('/announce/nope')).status, 404);
  });

  it('cancels a live announcement, 409s a finished one and 404s an unknown one', async () => {
    const { app, post, announcer, queued, history } = await setup();
    const submitted = await post('/announce', { text: 'x', target: 'all' });
    const { id } = (await submitted.json()) as { id: string };

    const cancelled = await app.request(`/announce/${id}`, { method: 'DELETE' });
    assert.equal(cancelled.status, 202);
    assert.deepEqual(await cancelled.json(), { id, state: 'cancelling' });
    assert.deepEqual(announcer.cancelled, [id]);

    queued('finished');
    history.update({
      id: 'finished',
      state: 'done',
      previousState: 'restoring',
      source: 'api',
      priority: 'normal',
      target: 'all',
      at: Date.now(),
    });
    assert.equal((await app.request('/announce/finished', { method: 'DELETE' })).status, 409);
    assert.equal((await app.request('/announce/nope', { method: 'DELETE' })).status, 404);

    // Known to the history as still running but not to the scheduler (another instance's).
    queued('elsewhere');
    const elsewhere = await app.request('/announce/elsewhere', { method: 'DELETE' });
    assert.equal(elsewhere.status, 202);
  });
});

describe('POST /tts', () => {
  it('synthesizes ahead of time and reports the clip', async () => {
    const { post, spoken } = await setup();
    const response = await post('/tts', { text: 'Warm me up', voice: 'Brian' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      uri: 'http://127.0.0.1:5005/tts/Warm%20me%20up.mp3',
      durationMs: 1500,
      cached: false,
      synthMs: 0,
      chunks: 1,
    });
    assert.deepEqual(spoken, [{ phrase: 'Warm me up', voice: 'Brian' }]);
    assert.equal((await post('/tts', {})).status, 400);
  });
});
