import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError } from '../config/errors.ts';
import { parsePreset } from './types.ts';

describe('parsePreset', () => {
  it('accepts the documented shape and keeps unknown keys', () => {
    const preset = parsePreset({
      players: [
        { roomName: '1. Kitchen', volume: 60 },
        { roomName: '1. Family Room', volume: '+5', mute: false },
      ],
      pauseOthers: true,
      playMode: { repeat: 'all', shuffle: true, crossfade: false },
      favorite: 'Morning',
      sleep: 600,
      'players-halloween': [{ roomName: 'Porch', volume: 90 }],
    });

    assert.equal(preset.players.length, 2);
    assert.equal(preset.pauseOthers, true);
    assert.deepEqual(preset.playMode, { repeat: 'all', shuffle: true, crossfade: false });
    assert.deepEqual(preset['players-halloween'], [
      { roomName: 'Porch', volume: 90 },
    ]);
  });

  it('normalizes boolean repeat values from older files', () => {
    assert.equal(parsePreset({ players: [{ roomName: 'A' }], playMode: { repeat: true } }).playMode?.repeat, 'all');
    assert.equal(parsePreset({ players: [{ roomName: 'A' }], playMode: { repeat: false } }).playMode?.repeat, 'none');
  });

  it('rejects presets without players, with bad volumes or bad repeat modes', () => {
    assert.throws(() => parsePreset({ players: [] }, 'doorbell'), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /Invalid doorbell/);
      assert.ok(error.issues[0]?.startsWith('players:'));
      return true;
    });
    assert.throws(() => parsePreset({ players: [{ roomName: 'A', volume: 'loud' }] }), ConfigError);
    assert.throws(() => parsePreset({ players: [{ roomName: 'A' }], playMode: { repeat: 'twice' } }), ConfigError);
    assert.throws(() => parsePreset('nope'), ConfigError);
  });
});
