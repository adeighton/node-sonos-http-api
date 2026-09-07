import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { AnnouncementResult, AnnouncementTransition } from '../announce/types.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { AnnouncementHistory } from './sqlite.ts';

const DAY = 24 * 60 * 60 * 1000;

function transition(
  overrides: Partial<AnnouncementTransition> & Pick<AnnouncementTransition, 'id' | 'state'>,
): AnnouncementTransition {
  return {
    previousState: undefined,
    source: 'say',
    priority: 'normal',
    target: 'room:Kitchen',
    at: 1_000_000,
    ...overrides,
  };
}

const RESULT: AnnouncementResult = {
  id: 'a1',
  state: 'done',
  source: 'say',
  priority: 'normal',
  rooms: ['Kitchen'],
  interruptions: 0,
  clip: { uri: 'http://x/tts/a.mp3', durationMs: 1200 },
  restore: 'ok',
  warnings: [],
  timings: { totalMs: 3000 },
};

describe('AnnouncementHistory', () => {
  it('records a submission, updates it through its states and keeps the result', () => {
    const history = AnnouncementHistory.open(':memory:');
    history.record(
      transition({
        id: 'a1',
        state: 'queued',
        textPreview: 'Dinner is ready',
        requestId: 'r1',
        idempotencyKey: 'k1',
      }),
    );
    history.update(transition({ id: 'a1', state: 'starting', at: 1_000_100 }));
    history.update(transition({ id: 'a1', state: 'playing', at: 1_000_200, rooms: ['Kitchen'] }));
    history.update(transition({ id: 'a1', state: 'done', at: 1_003_000, result: RESULT }));

    assert.deepEqual(history.get('a1'), {
      id: 'a1',
      state: 'done',
      priority: 'normal',
      source: 'say',
      target: 'room:Kitchen',
      textPreview: 'Dinner is ready',
      requestId: 'r1',
      idempotencyKey: 'k1',
      receivedAt: 1_000_000,
      updatedAt: 1_003_000,
      rooms: ['Kitchen'],
      result: RESULT,
      error: undefined,
    });
    assert.equal(history.get('nope'), undefined);

    history.record(transition({ id: 'a2', state: 'queued', at: 1_004_000 }));
    history.update(transition({ id: 'a2', state: 'failed', at: 1_004_500, error: 'polly down' }));
    assert.equal(history.get('a2')?.error, 'polly down');
    assert.equal(history.get('a2')?.result, undefined);
    history.close();
  });

  it('lists newest first, filtered by state, capped', () => {
    const history = AnnouncementHistory.open(':memory:');
    for (let i = 0; i < 5; i += 1) {
      history.record(transition({ id: `a${i}`, state: 'queued', at: 1_000_000 + i }));
    }
    history.update(transition({ id: 'a1', state: 'done', at: 1_000_010 }));
    history.update(transition({ id: 'a3', state: 'done', at: 1_000_011 }));

    assert.deepEqual(
      history.list().map((entry) => entry.id),
      ['a4', 'a3', 'a2', 'a1', 'a0'],
    );
    assert.deepEqual(
      history.list({ limit: 2 }).map((entry) => entry.id),
      ['a4', 'a3'],
    );
    assert.deepEqual(
      history.list({ state: 'done' }).map((entry) => entry.id),
      ['a3', 'a1'],
    );
    history.close();
  });

  it('finds the latest announcement with an idempotency key inside the window', () => {
    let now = 2_000_000;
    const history = AnnouncementHistory.open(':memory:', { now: () => now });
    history.record(transition({ id: 'old', state: 'queued', idempotencyKey: 'k', at: 1_000_000 }));
    history.record(transition({ id: 'new', state: 'queued', idempotencyKey: 'k', at: 1_900_000 }));
    history.record(
      transition({ id: 'other', state: 'queued', idempotencyKey: 'x', at: 1_950_000 }),
    );

    assert.equal(history.findByIdempotencyKey('k', 200_000)?.id, 'new');
    assert.equal(history.findByIdempotencyKey('k', 50_000), undefined, 'outside the window');
    now = 1_950_000;
    assert.equal(history.findByIdempotencyKey('k', 100_000)?.id, 'new');
    assert.equal(history.findByIdempotencyKey('missing', DAY), undefined);
    history.close();
  });

  it('persists to a file, prunes old entries on open and survives a reopen', async () => {
    await withTempDir((dir) => {
      const file = join(dir, 'announcements.sqlite');
      const now = 100 * DAY;
      const first = AnnouncementHistory.open(file, { now: () => now, retentionDays: 30 });
      first.record(transition({ id: 'ancient', state: 'queued', at: now - 31 * DAY }));
      first.record(transition({ id: 'recent', state: 'queued', at: now - 27 * DAY }));
      assert.equal(first.prune(30 * DAY), 1, 'pruning is explicit too');
      first.close();

      const second = AnnouncementHistory.open(file, {
        now: () => now + 2 * DAY,
        retentionDays: 30,
      });
      assert.equal(second.get('recent')?.id, 'recent', 'rows survive a reopen');
      assert.equal(second.get('ancient'), undefined);
      second.record(transition({ id: 'stale', state: 'queued', at: now - 40 * DAY }));
      second.close();

      const third = AnnouncementHistory.open(file, { now: () => now + 2 * DAY, retentionDays: 30 });
      assert.deepEqual(
        third.list().map((entry) => entry.id),
        ['recent'],
        'opening prunes what is past the retention',
      );
      third.close();
      return Promise.resolve();
    });
  });

  it('falls back to memory with a warning when the file cannot be opened', () => {
    const { logger, messages } = captureLogs();
    const history = AnnouncementHistory.open('/nonexistent-dir/x/y/announcements.sqlite', {
      logger,
    });
    history.record(transition({ id: 'a1', state: 'queued' }));
    assert.equal(history.get('a1')?.id, 'a1');
    assert.ok(messages().some((m) => m.startsWith('could not open the announcement history')));
    history.close();
  });

  it('follows a scheduler, recording queued and updating the rest, without ever throwing', () => {
    const { logger, messages } = captureLogs();
    const history = AnnouncementHistory.open(':memory:', { logger });
    const scheduler = new EventEmitter<{ transition: [AnnouncementTransition] }>();
    const unfollow = history.follow(scheduler);

    scheduler.emit('transition', transition({ id: 'a1', state: 'queued', textPreview: 'Hi' }));
    scheduler.emit(
      'transition',
      transition({ id: 'a1', state: 'done', at: 1_001_000, result: RESULT }),
    );
    assert.equal(history.get('a1')?.state, 'done');
    assert.equal(history.get('a1')?.textPreview, 'Hi');

    history.close();
    scheduler.emit('transition', transition({ id: 'a2', state: 'queued' }));
    assert.ok(messages().includes('could not record the announcement'), 'logged, not thrown');
    unfollow();
    assert.equal(scheduler.listenerCount('transition'), 0);
  });
});
