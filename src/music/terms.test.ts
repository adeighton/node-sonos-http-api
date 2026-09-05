import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSearchTerms, songSearchKind } from './terms.ts';

describe('parseSearchTerms', () => {
  it('keeps plain terms whole', () => {
    assert.deepEqual(parseSearchTerms('hotel california'), {
      term: 'hotel california',
      artist: '',
      album: '',
      track: '',
    });
  });

  it('splits specifiers in any order', () => {
    assert.deepEqual(parseSearchTerms('artist:Eagles track:Hotel California'), {
      term: '',
      artist: 'Eagles',
      album: '',
      track: 'Hotel California',
    });
    assert.deepEqual(parseSearchTerms('album:Hotel California artist:Eagles'), {
      term: '',
      artist: 'Eagles',
      album: 'Hotel California',
      track: '',
    });
    assert.deepEqual(parseSearchTerms('track:Desperado').track, 'Desperado');
  });

  it('classifies song searches', () => {
    assert.equal(songSearchKind(parseSearchTerms('x')), 'song');
    assert.equal(songSearchKind(parseSearchTerms('artist:Eagles')), 'artist');
    assert.equal(songSearchKind(parseSearchTerms('artist:Eagles track:Desperado')), 'track');
  });
});
