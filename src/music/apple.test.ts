import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appleMusic } from './apple.ts';
import { parseSearchTerms } from './terms.ts';
import type { ServiceAccount } from './types.ts';

const account: ServiceAccount = {
  sid: 204,
  serviceType: 52231,
  accountId: 'user@example.com',
  accountSN: '4',
  country: 'US',
};

describe('appleMusic', () => {
  it('builds iTunes search urls with attribute hints from the specifiers', () => {
    const terms = parseSearchTerms('artist:Daft Punk track:One More Time');
    assert.equal(
      appleMusic.searchUrl('song', terms, 'US'),
      'https://itunes.apple.com/search?media=music&limit=50&entity=song&term=Daft%20Punk%20One%20More%20Time&attribute=artistTerm&attribute=songTerm&country=US',
    );
    assert.equal(
      appleMusic.searchUrl('album', parseSearchTerms('Discovery'), 'GB'),
      'https://itunes.apple.com/search?media=music&limit=1&entity=album&attribute=albumTerm&term=Discovery&country=GB',
    );
    assert.equal(
      appleMusic.searchUrl('album', parseSearchTerms('artist:Daft Punk album:Discovery'), 'US'),
      'https://itunes.apple.com/search?media=music&limit=1&entity=album&attribute=albumTerm&term=Daft%20Punk%20Discovery&attribute=artistTerm&country=US',
    );
    assert.throws(
      () => appleMusic.searchUrl('playlist', terms, 'US'),
      /cannot search for playlist/,
    );
    assert.throws(() => appleMusic.parse('playlist', {}), /cannot search for playlist/);
    assert.equal(appleMusic.needsCountry, true);
  });

  it('turns song results into deduplicated streamable queue tracks', () => {
    const results = appleMusic.parse('song', {
      resultCount: 3,
      results: [
        { trackId: 1, trackName: 'One More Time', artistName: 'Daft Punk', isStreamable: true },
        { trackId: 2, trackName: 'One More Time', artistName: 'Daft Punk', isStreamable: true },
        { trackId: 3, trackName: 'Aerodynamic', artistName: 'Daft Punk', isStreamable: false },
      ],
    });

    assert.equal(results.empty, false);
    const tracks = results.tracks(account);
    assert.equal(tracks.count, 1);
    assert.equal(tracks.isArtist, false);
    assert.equal(tracks.queueTracks[0]?.uri, 'x-sonos-http:song%3a1.mp4?sid=204&flags=8224&sn=4');
    assert.match(
      tracks.queueTracks[0]?.metadata ?? '',
      /id="00032020song%3a1" parentID="00020000song:1"/,
    );
    assert.match(tracks.queueTracks[0]?.metadata ?? '', /SA_RINCON52231_X_#Svc52231-0-Token/);
  });

  it('builds album and station uris with metadata', () => {
    const album = appleMusic
      .parse('album', {
        resultCount: 1,
        results: [{ collectionId: 55, collectionName: 'Discovery', artistName: 'Daft Punk' }],
      })
      .first(account);
    assert.equal(album.uri, 'x-rincon-cpcontainer:0004206calbum%3a55');
    assert.match(album.metadata, /id="0004206calbum%3a55" parentID="00020000album:discovery"/);
    assert.match(album.metadata, /object\.container\.album\.musicAlbum\.#AlbumView/);

    const station = appleMusic
      .parse('station', { resultCount: 1, results: [{ artistId: 77, artistName: 'Daft Punk' }] })
      .first(account);
    assert.equal(station.uri, 'x-sonosapi-radio:radio%3ara.77?sid=204&flags=8300&sn=4');
    assert.match(station.metadata, /<dc:title>Daft Punk Radio<\/dc:title>/);
    assert.match(station.metadata, /parentID="00020000radio:daft punk"/);
  });

  it('reports empty results and rejects unexpected payloads', () => {
    const empty = appleMusic.parse('song', { resultCount: 0, results: [] });
    assert.equal(empty.empty, true);
    assert.throws(() => empty.first(account), /No matches/);
    assert.equal(empty.tracks(account).count, 0);
    assert.throws(() => appleMusic.parse('song', { nope: true }));
  });
});
