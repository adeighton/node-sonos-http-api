import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REPEAT_MODE,
  URI_TYPE,
  buildSnapshot,
  createEmptyState,
  deepFreeze,
  formatTime,
  getPlayMode,
  getUriType,
  parseTime,
} from './player-state.ts';
import type { PlayModeName, RepeatMode } from './player-state.ts';

describe('parseTime', () => {
  it('returns 0 for undefined and unparseable input', () => {
    assert.equal(parseTime(undefined), 0);
    assert.equal(parseTime('NOT_IMPLEMENTED'), 0);
    assert.equal(parseTime(''), 0);
  });

  it('parses hours, minutes and seconds', () => {
    assert.equal(parseTime('0:00:05'), 5);
    assert.equal(parseTime('02:03'), 123);
    assert.equal(parseTime('1:02:03'), 3723);
    assert.equal(parseTime('45'), 45);
  });
});

describe('formatTime', () => {
  it('zero-pads every component', () => {
    assert.equal(formatTime(0), '00:00:00');
    assert.equal(formatTime(5), '00:00:05');
    assert.equal(formatTime(3723), '01:02:03');
  });

  it('lets hours grow past two digits and floors fractions', () => {
    assert.equal(formatTime(360000), '100:00:00');
    assert.equal(formatTime(61.9), '00:01:01');
    assert.equal(formatTime(-3), '00:00:00');
  });

  it('round-trips through parseTime', () => {
    for (const seconds of [0, 1, 59, 60, 3599, 3600, 86399]) {
      assert.equal(parseTime(formatTime(seconds)), seconds);
    }
  });
});

describe('getPlayMode', () => {
  const table: Array<[boolean, RepeatMode, PlayModeName]> = [
    [false, REPEAT_MODE.NONE, 'NORMAL'],
    [false, REPEAT_MODE.ALL, 'REPEAT_ALL'],
    [false, REPEAT_MODE.ONE, 'REPEAT_ONE'],
    [true, REPEAT_MODE.NONE, 'SHUFFLE_NOREPEAT'],
    [true, REPEAT_MODE.ALL, 'SHUFFLE'],
    [true, REPEAT_MODE.ONE, 'SHUFFLE_REPEAT_ONE'],
  ];

  for (const [shuffle, repeat, expected] of table) {
    it(`maps shuffle=${String(shuffle)} repeat=${repeat} to ${expected}`, () => {
      assert.equal(getPlayMode({ shuffle, repeat }), expected);
    });
  }
});

describe('getUriType', () => {
  it('detects radio streams', () => {
    for (const uri of [
      'x-sonosapi-stream:s1234?sid=254',
      'x-sonosapi-radio:abc',
      'pndrradio:1',
      'x-sonosapi-hls:x',
      'x-sonosprog-http:song',
      'x-rincon-mp3radio://stream',
    ]) {
      assert.equal(getUriType(uri), URI_TYPE.RADIO, uri);
    }
  });

  it('detects line-in and TV inputs', () => {
    assert.equal(getUriType('x-rincon-stream:RINCON_1'), URI_TYPE.LINE_IN);
    assert.equal(getUriType('x-sonos-htastream:RINCON_1:spdif'), URI_TYPE.LINE_IN);
  });

  it('treats everything else as a track', () => {
    assert.equal(getUriType('x-file-cifs://nas/song.mp3'), URI_TYPE.TRACK);
    assert.equal(getUriType('http://host/clip.mp3'), URI_TYPE.TRACK);
    assert.equal(getUriType(''), URI_TYPE.TRACK);
  });
});

describe('deepFreeze', () => {
  it('freezes a copy recursively and leaves the source mutable', () => {
    const source = { volume: 1, nested: { value: 'a' }, list: [1, 2] };
    const frozen = deepFreeze(source);

    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.nested));
    assert.notEqual(frozen.nested, source.nested);
    assert.deepEqual(frozen, source);

    source.volume = 2;
    source.nested.value = 'b';
    assert.equal(frozen.volume, 1);
    assert.equal(frozen.nested.value, 'a');
  });
});

describe('createEmptyState', () => {
  it('returns independent copies', () => {
    const first = createEmptyState();
    const second = createEmptyState();
    first.currentTrack.title = 'changed';
    first.playMode.shuffle = true;

    assert.equal(second.currentTrack.title, '');
    assert.equal(second.playMode.shuffle, false);
    assert.equal(second.playbackState, 'STOPPED');
    assert.equal(second.currentTrack.type, URI_TYPE.TRACK);
  });
});

describe('buildSnapshot', () => {
  it('combines own volume with the coordinator transport state', () => {
    const player = createEmptyState();
    player.volume = 12;
    player.mute = true;
    const coordinator = createEmptyState();
    coordinator.currentTrack.title = 'Song';
    coordinator.trackNo = 3;
    coordinator.playbackState = 'PAUSED_PLAYBACK';
    coordinator.relTime = 42;
    coordinator.stateTime = 1_000;

    const snapshot = buildSnapshot(player, coordinator, null, 60_000);

    assert.equal(snapshot.volume, 12);
    assert.equal(snapshot.mute, true);
    assert.equal(snapshot.currentTrack.title, 'Song');
    assert.equal(snapshot.trackNo, 3);
    assert.equal(snapshot.playbackState, 'PAUSED_PLAYBACK');
    assert.equal(snapshot.elapsedTime, 42, 'no drift is added unless playing');
    assert.equal(snapshot.elapsedTimeFormatted, '00:00:42');
    assert.equal(snapshot.sub, undefined);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.currentTrack));
  });

  it('extrapolates elapsed time while playing', () => {
    const coordinator = createEmptyState();
    coordinator.playbackState = 'PLAYING';
    coordinator.relTime = 10;
    coordinator.stateTime = 5_000;

    const snapshot = buildSnapshot(createEmptyState(), coordinator, null, 8_600);

    assert.equal(snapshot.elapsedTime, 13);
    assert.equal(snapshot.elapsedTimeFormatted, '00:00:13');
  });

  it('includes the sub state when provided', () => {
    const snapshot = buildSnapshot(createEmptyState(), createEmptyState(), {
      gain: 2,
      enabled: true,
    });

    assert.deepEqual(snapshot.sub, { gain: 2, enabled: true });
  });
});
