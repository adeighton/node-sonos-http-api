import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from './errors.ts';
import { announceBodySchema, parseBody, roomsOf, ttsBodySchema } from './announce-schema.ts';

describe('announceBodySchema', () => {
  it('accepts every target shape and fills the defaults', () => {
    const body = parseBody(announceBodySchema, { text: 'Hi', target: 'all' });
    assert.deepEqual(body, { text: 'Hi', target: 'all', priority: 'normal', wait: false });
    assert.equal(roomsOf(body.target), undefined);

    const preset = parseBody(announceBodySchema, {
      clip: 'ding.mp3',
      target: { preset: 'doorbell' },
      priority: 'urgent',
      pauseOthers: false,
    });
    assert.deepEqual(preset.target, { preset: 'doorbell' });
    assert.equal(preset.priority, 'urgent');
    assert.equal(roomsOf(preset.target), undefined);

    const rooms = parseBody(announceBodySchema, {
      ssml: '<speak>Hi</speak>',
      target: { rooms: ['Kitchen', { name: 'Office', volume: 20 }] },
      volume: 30,
      voice: 'Amy',
      engine: 'standard',
      wait: true,
      idempotencyKey: '2026-09-07-briefing',
    });
    assert.deepEqual(roomsOf(rooms.target), [{ name: 'Kitchen' }, { name: 'Office', volume: 20 }]);

    const shorthand = parseBody(announceBodySchema, { text: 'Hi', target: ['Den'] });
    assert.deepEqual(roomsOf(shorthand.target), [{ name: 'Den' }]);
  });

  it('rejects bodies that say too little or too much, with the reason', () => {
    const bad = (value: unknown, pattern: RegExp) =>
      assert.throws(
        () => parseBody(announceBodySchema, value),
        (error: unknown) => error instanceof BadRequestError && pattern.test(error.message),
      );

    bad({ target: 'all' }, /exactly one of text, ssml or clip/);
    bad({ text: 'a', clip: 'b.mp3', target: 'all' }, /exactly one/);
    bad({ text: 'a' }, /target/);
    bad({ text: 'a', target: { rooms: [] } }, /target/);
    bad({ text: 'a', target: 'all', volume: 101 }, /volume/);
    bad({ text: 'a', target: 'all', priority: 'now' }, /priority/);
    bad({ text: 'a', target: 'all', engine: 'robot' }, /engine/);
    bad({ text: '', target: 'all' }, /text/);
    bad('nope', /Invalid request body/);
  });
});

describe('ttsBodySchema', () => {
  it('takes text or ssml, not both, with voice and engine', () => {
    assert.deepEqual(parseBody(ttsBodySchema, { text: 'Hi', voice: 'Amy' }), {
      text: 'Hi',
      voice: 'Amy',
    });
    assert.throws(() => parseBody(ttsBodySchema, {}), /exactly one of text or ssml/);
    assert.throws(() => parseBody(ttsBodySchema, { text: 'a', ssml: '<speak/>' }), BadRequestError);
  });
});
