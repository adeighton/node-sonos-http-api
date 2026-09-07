import assert from 'node:assert/strict';

import type { AnnouncementResult } from '../../src/announce/types.ts';
import { describeLive } from './boot.ts';

const VOLUME = '15';

/** Long enough to be split into more than one Polly request (chunk target 800 characters). */
const BRIEFING = [
  'Good morning. This is the live text-to-speech test of the announcement pipeline. It reads a text',
  'that is longer than one synthesis request, so the server has to split it at sentence boundaries,',
  'synthesize the parts in parallel and join them into a single clip before playing it.',
  '',
  'Today the weather is whatever it is outside. The first meeting starts at nine, the second one at',
  'eleven, and lunch is at half past twelve. The dishwasher would like to be emptied, the plants',
  'would like some water, and the cat would like everyone to know that it has not been fed for at',
  'least four minutes.',
  '',
  'Family history spotlight: on this day, several years ago, somebody in this house successfully',
  'assembled a bookshelf without leftover screws. Have a good day.',
].join('\n');

function announcement(body: unknown): AnnouncementResult {
  const result = body as { announcement?: AnnouncementResult };
  assert.ok(result.announcement, JSON.stringify(body));
  return result.announcement;
}

describeLive('text-to-speech (live)', ({ it }) => {
  it('synthesizes a phrase once and serves the cached clip afterwards', async ({ harness }, t) => {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    const phrase = `Live cache test ${Date.now()}`;
    await harness.withRestore(async (before) => {
      const miss = await harness.action(room, 'say', phrase, VOLUME);
      assert.equal(miss.status, 200, JSON.stringify(miss.body));
      const first = announcement(miss.body);
      assert.equal(first.clip?.cached, false, 'a new phrase is synthesized');
      assert.ok(
        (first.timings.prepareMs ?? 0) > 50,
        `synthesis took ${first.timings.prepareMs} ms`,
      );
      assert.equal(first.restore, 'ok', first.warnings.join('; '));
      await harness.assertRestored(before);

      const hit = await harness.action(room, 'say', phrase, VOLUME);
      assert.equal(hit.status, 200, JSON.stringify(hit.body));
      const second = announcement(hit.body);
      assert.equal(second.clip?.cached, true, 'the same phrase comes from the cache');
      assert.equal(second.clip?.uri, first.clip?.uri);
      assert.ok(
        (second.timings.prepareMs ?? 0) < 200,
        `cache hit took ${second.timings.prepareMs} ms`,
      );
      await harness.assertRestored(before);
    });
  });

  it('reads a multi-paragraph briefing longer than one Polly request as a single clip', async ({
    harness,
  }, t) => {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    await harness.withRestore(async (before) => {
      const response = await harness.action(room, 'say', BRIEFING, VOLUME);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const result = announcement(response.body);
      const seconds = (result.clip?.durationMs ?? 0) / 1000;
      assert.ok(
        seconds > 30 && seconds < 120,
        `a ${BRIEFING.length}-character text took ${seconds} s`,
      );
      assert.ok(
        (result.timings.playMs ?? 0) < (result.clip?.durationMs ?? 0) + 2500,
        'the end of the clip was detected rather than waited out',
      );
      assert.equal(result.restore, 'ok', result.warnings.join('; '));
      await harness.assertRestored(before);
    });
  });

  it('rejects an unknown voice before touching the speakers', async ({ harness }, t) => {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    const response = await harness.action(room, 'say', 'hello', 'Gandalf', VOLUME);
    assert.equal(response.status, 400, JSON.stringify(response.body));
  });
});
