import assert from 'node:assert/strict';

import type { AnnouncementResult, AnnouncementState } from '../../src/announce/types.ts';
import type { HistoryEntry } from '../../src/history/sqlite.ts';
import { LiveHarness } from '../../src/testing/live-harness.ts';
import { describeLive } from './boot.ts';

const CLIP = 'TacoBellBong.mp3';
const VOLUME = 15;
const TERMINAL = new Set<AnnouncementState>(['done', 'failed', 'cancelled']);

/** About 45 seconds of speech: long enough for a doorbell to land in the middle of it. */
const BRIEFING = [
  'Good morning. This is the live test of the announcement API. It is deliberately long, so that',
  'an urgent announcement can interrupt it and it can carry on from where it stopped afterwards.',
  '',
  'The first meeting starts at nine, the second one at eleven, and lunch is at half past twelve.',
  'The dishwasher would like to be emptied, the plants would like some water, and the cat would',
  'like everyone to know that it has not been fed for at least four minutes.',
  '',
  'On this day, several years ago, somebody in this house assembled a bookshelf without leftover',
  'screws. Have a good day.',
].join('\n');

function ttsConfigured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(harness: LiveHarness, path: string, body: unknown, headers = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Polls `GET /announce/:id` until the announcement reaches a terminal state or a wanted one. */
async function waitFor(
  harness: LiveHarness,
  id: string,
  wanted: (entry: HistoryEntry) => boolean,
  timeoutMs = 90_000,
): Promise<HistoryEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await harness.get(`/announce/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const entry = response.body as HistoryEntry;
    if (wanted(entry) || TERMINAL.has(entry.state)) {
      return entry;
    }

    assert.ok(
      Date.now() < deadline,
      `announcement ${id} still ${entry.state} after ${timeoutMs} ms`,
    );
    await sleep(500);
  }
}

const finished = (entry: HistoryEntry) => TERMINAL.has(entry.state);

/** Subscribes to `/events` and collects the announcement transitions until closed. */
async function announcementEvents(baseUrl: string) {
  const controller = new AbortController();
  const events: Array<{ type: string; data: { id: string; state: string } }> = [];
  const stream = await fetch(new URL('/events', baseUrl), { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reading = (async () => {
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (reader) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) {
          events.push(JSON.parse(data) as (typeof events)[number]);
        }
      }
    }
  })();

  return {
    /** The states one announcement passed through, in order. */
    statesOf: (id: string) =>
      events
        .filter((event) => event.type === 'announcement' && event.data.id === id)
        .map((event) => event.data.state),
    close: async () => {
      controller.abort();
      await reading;
    },
  };
}

describeLive('announcement API (live)', ({ it }) => {
  it('queues a clip with 202, reports it through GET /announce/:id and lists it', async ({
    harness,
  }) => {
    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const queued = await post(harness, '/announce', {
        clip: CLIP,
        target: [room],
        volume: VOLUME,
      });
      assert.equal(queued.status, 202, JSON.stringify(queued.body));
      const { id } = queued.body as { id: string };
      assert.equal(queued.headers.get('Location'), `/announce/${id}`);

      const entry = await waitFor(harness, id, finished);
      assert.equal(entry.state, 'done', JSON.stringify(entry));
      assert.equal(entry.source, 'api');
      assert.equal(entry.target, `rooms:${room}`);
      assert.equal(entry.textPreview, CLIP);
      assert.deepEqual(entry.rooms, [room]);
      assert.equal(entry.result?.restore, 'ok', entry.result?.warnings.join('; '));
      assert.equal(typeof entry.result?.timings.playMs, 'number');
      await harness.assertRestored(before);

      const list = await harness.get('/announce?limit=5');
      assert.equal(list.status, 200);
      assert.ok(
        (list.body as HistoryEntry[]).some((item) => item.id === id),
        'listed',
      );
    });
  });

  it('waits for the result when asked and replays an idempotency key instead of playing twice', async ({
    harness,
  }) => {
    const room = harness.rooms[0] ?? '';
    const key = `live-${Date.now()}`;
    await harness.withRestore(async (before) => {
      const played = await post(harness, '/announce', {
        clip: CLIP,
        target: { rooms: [{ name: room, volume: VOLUME }] },
        wait: true,
        idempotencyKey: key,
      });
      assert.equal(played.status, 200, JSON.stringify(played.body));
      const { announcement } = played.body as { announcement: AnnouncementResult };
      assert.equal(announcement.state, 'done');
      assert.equal(announcement.restore, 'ok');
      await harness.assertRestored(before);

      const replayed = await post(harness, '/announce', {
        clip: CLIP,
        target: [room],
        idempotencyKey: key,
      });
      assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
      assert.equal(replayed.headers.get('Idempotent-Replayed'), 'true');
      assert.equal((replayed.body as HistoryEntry).id, announcement.id);
    });
  });

  it('an urgent clip interrupts a playing briefing, which resumes and finishes', async ({
    harness,
  }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const briefing = await post(harness, '/announce', {
        text: BRIEFING,
        target: [room],
        volume: VOLUME,
      });
      assert.equal(briefing.status, 202, JSON.stringify(briefing.body));
      const briefingId = (briefing.body as { id: string }).id;
      await waitFor(harness, briefingId, (entry) => entry.state === 'playing', 40_000);
      await sleep(5000);

      const doorbell = await post(harness, '/announce', {
        clip: CLIP,
        target: [room],
        volume: VOLUME,
        priority: 'urgent',
      });
      assert.equal(doorbell.status, 202, JSON.stringify(doorbell.body));
      const doorbellId = (doorbell.body as { id: string }).id;

      const parked = await waitFor(
        harness,
        briefingId,
        (entry) => entry.state === 'interrupted',
        15_000,
      );
      assert.equal(parked.state, 'interrupted', JSON.stringify(parked));
      const rang = await waitFor(harness, doorbellId, finished, 30_000);
      assert.equal(rang.state, 'done', JSON.stringify(rang));
      assert.equal(rang.result?.restore, 'ok', rang.result?.warnings.join('; '));

      const resumed = await waitFor(harness, briefingId, finished, 90_000);
      assert.equal(resumed.state, 'done', JSON.stringify(resumed));
      assert.equal(resumed.result?.interruptions, 1);
      assert.equal(resumed.result?.restore, 'ok', resumed.result?.warnings.join('; '));
      await harness.assertRestored(before);
    });
  });

  it('DELETE cancels a queued announcement at once and a playing one after a restore', async ({
    harness,
  }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const playing = await post(harness, '/announce', {
        text: BRIEFING,
        target: [room],
        volume: VOLUME,
      });
      const waiting = await post(harness, '/announce', {
        clip: CLIP,
        target: [room],
        volume: VOLUME,
      });
      const playingId = (playing.body as { id: string }).id;
      const waitingId = (waiting.body as { id: string }).id;

      const dropped = await harness.request(`/announce/${waitingId}`, { method: 'DELETE' });
      assert.equal(dropped.status, 202, JSON.stringify(dropped.body));
      assert.equal((await waitFor(harness, waitingId, finished, 5000)).state, 'cancelled');

      await waitFor(harness, playingId, (entry) => entry.state === 'playing', 40_000);
      await sleep(2000);
      const stopped = await harness.request(`/announce/${playingId}`, { method: 'DELETE' });
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      const entry = await waitFor(harness, playingId, finished, 30_000);
      assert.equal(entry.state, 'cancelled', JSON.stringify(entry));
      assert.ok((entry.result?.timings.playMs ?? 0) < 15_000, 'stopped early');
      await harness.assertRestored(before);

      const again = await harness.request(`/announce/${playingId}`, { method: 'DELETE' });
      assert.equal(again.status, 409);
    });
  });

  it('streams the lifecycle over /events', async ({ harness, baseUrl }) => {
    const room = harness.rooms[0] ?? '';
    const events = await announcementEvents(baseUrl);
    try {
      await harness.withRestore(async () => {
        const played = await post(harness, '/announce', {
          clip: CLIP,
          target: [room],
          volume: VOLUME,
          wait: true,
        });
        assert.equal(played.status, 200, JSON.stringify(played.body));
        const { id } = (played.body as { announcement: { id: string } }).announcement;
        await sleep(500);
        assert.deepEqual(events.statesOf(id), [
          'queued',
          'starting',
          'playing',
          'restoring',
          'done',
        ]);
      });
    } finally {
      await events.close();
    }
  });

  it('an announcement with an unknown voice fails without touching a single room', async ({
    harness,
    baseUrl,
  }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    const events = await announcementEvents(baseUrl);
    try {
      // Compared in full, transport and playback state included: this room should be untouched,
      // not restored, so there is nothing to forgive.
      const before = await harness.snapshot([room]);

      const doomed = await post(harness, '/announce', {
        text: 'This should never be heard.',
        target: [room],
        volume: VOLUME,
        voice: 'Gandalf',
      });
      assert.equal(doomed.status, 202, JSON.stringify(doomed.body));
      const { id } = doomed.body as { id: string };

      const entry = await waitFor(harness, id, finished, 30_000);
      assert.equal(entry.state, 'failed', JSON.stringify(entry));
      assert.match(entry.error ?? '', /Unknown Polly voice 'Gandalf'/);
      await sleep(500);
      assert.deepEqual(
        events.statesOf(id),
        ['queued', 'starting', 'failed'],
        'no restoring: nothing was grouped, so nothing had to be put back',
      );
      assert.deepEqual(LiveHarness.differences(before, await harness.snapshot([room])), []);
    } finally {
      await events.close();
    }
  });

  it('POST /tts synthesizes ahead of time and answers from the cache afterwards', async ({
    harness,
  }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const text = `Pre-warm ${Date.now()}`;
    const miss = await post(harness, '/tts', { text });
    assert.equal(miss.status, 200, JSON.stringify(miss.body));
    const first = miss.body as { uri: string; durationMs: number; cached: boolean; chunks: number };
    assert.equal(first.cached, false);
    assert.ok(first.durationMs > 500);
    assert.equal(first.chunks, 1);

    const hit = await post(harness, '/tts', { text });
    const second = hit.body as { uri: string; cached: boolean };
    assert.equal(second.cached, true);
    assert.equal(second.uri, first.uri);
    assert.equal((await post(harness, '/tts', { text, engine: 'robot' })).status, 400);
  });

  it('validates bodies and targets', async ({ harness }) => {
    assert.equal((await post(harness, '/announce', { target: 'all' })).status, 400);
    assert.equal((await post(harness, '/announce', { clip: CLIP, target: ['Attic'] })).status, 404);
    assert.equal(
      (await post(harness, '/announce', { clip: CLIP, target: { preset: 'nope' } })).status,
      404,
    );
    assert.equal(
      (await post(harness, '/announce', { clip: 'missing.mp3', target: 'all' })).status,
      404,
    );
    assert.equal((await harness.get('/announce/nope')).status, 404);
  });
});
