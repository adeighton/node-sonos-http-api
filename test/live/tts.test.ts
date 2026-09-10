import assert from 'node:assert/strict';

import type { AnnouncementResult } from '../../src/announce/types.ts';
import { describeLive } from './boot.ts';

const VOLUME = '15';

/** The shape of the daily briefing: several paragraphs, one Polly request. */
const BRIEFING = [
  'Good morning. This is the live text-to-speech test of the announcement pipeline. It reads a',
  'multi-paragraph text that is sent to Polly whole, as one request, so the intonation carries',
  'across the paragraphs the way it would if a person read them.',
  '',
  'Today the weather is whatever it is outside. The first meeting starts at nine, the second one at',
  'eleven, and lunch is at half past twelve. The dishwasher would like to be emptied, the plants',
  'would like some water, and the cat would like everyone to know that it has not been fed for at',
  'least four minutes.',
  '',
  'Family history spotlight: on this day, several years ago, somebody in this house successfully',
  'assembled a bookshelf without leftover screws. Have a good day.',
].join('\n');

function ttsConfigured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID);
}

function announcement(body: unknown): AnnouncementResult {
  const result = body as { announcement?: AnnouncementResult };
  assert.ok(result.announcement, JSON.stringify(body));
  return result.announcement;
}

describeLive('text-to-speech (live)', ({ it }) => {
  it('synthesizes a phrase once and serves the cached clip afterwards', async ({ harness }, t) => {
    if (!ttsConfigured()) {
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

  it('reads a multi-paragraph briefing as one request and one clip', async ({ harness }, t) => {
    if (!ttsConfigured()) {
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

  it('serves the Polly voice catalog it validates against', async ({ harness }) => {
    const response = await harness.get('/voices');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
    const { voices, engines } = response.body as {
      voices: Array<{ id: string; gender: string; language: string; engines: string[] }>;
      engines: string[];
    };
    assert.deepEqual(engines, ['standard', 'neural', 'long-form', 'generative']);

    if (!ttsConfigured()) {
      assert.deepEqual(voices, [], 'no Polly provider: an empty list, not an error');
      return;
    }

    assert.ok(
      voices.length > 50,
      `Polly offers more than a handful of voices, got ${voices.length}`,
    );
    for (const voice of voices) {
      assert.ok(voice.id.length > 0, JSON.stringify(voice));
      assert.ok(voice.gender.length > 0, JSON.stringify(voice));
      // Polly's codes are BCP 47-ish: en-US, but also arb, cmn-CN and en-GB-WLS.
      assert.match(voice.language, /^[a-z]{2,3}(-[A-Za-z]{2,3})*$/, JSON.stringify(voice));
      assert.ok(voice.engines.length > 0, JSON.stringify(voice));
      for (const engine of voice.engines) {
        assert.ok(engines.includes(engine), `unknown engine ${engine} on ${voice.id}`);
      }
    }

    // The dropdown and the announcement read the same list: what it offers is what will play.
    const configured = process.env.SONOS_POLLY_VOICE ?? 'Joanna';
    const preferred = voices.find((voice) => voice.id === configured);
    assert.ok(preferred, `the configured voice ${configured} is in the catalog`);
    const engine = process.env.SONOS_POLLY_ENGINE ?? 'neural';
    assert.ok(preferred.engines.includes(engine), `${configured} supports ${engine}`);
  });

  it("refuses a text over Polly's limit with a 400 that names it", async ({ harness }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    const tooLong = 'This sentence is here to make the text too long for one request. '.repeat(48);
    const response = await harness.action(room, 'say', tooLong, VOLUME);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(JSON.stringify(response.body), /at most 3000 billed/);
  });

  it('rejects an unknown voice before touching the speakers', async ({ harness }, t) => {
    if (!ttsConfigured()) {
      t.skip('AWS credentials are not configured');
      return;
    }

    const room = harness.rooms[0] ?? '';
    const response = await harness.action(room, 'say', 'hello', 'Gandalf', VOLUME);
    assert.equal(response.status, 400, JSON.stringify(response.body));
  });
});
