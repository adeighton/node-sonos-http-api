import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDeezerService } from './deezer.ts';
import { parseSearchTerms } from './terms.ts';
import type { ServiceAccount } from './types.ts';

const account: ServiceAccount = {
  sid: 2,
  serviceType: 519,
  accountId: 'deezer@example.com',
  accountSN: '7',
  country: '',
};

const song = {
  id: 9,
  title: 'Song A',
  artist: { id: 1, name: 'Art' },
  album: { id: 5, title: 'Alb' },
};

describe('createDeezerService', () => {
  it('builds Deezer search urls with artist/track/album specifiers', () => {
    const deezer = createDeezerService();
    assert.equal(deezer.name, 'deezer');
    assert.equal(deezer.sonosName, 'Deezer');
    assert.equal(deezer.needsCountry, false);
    assert.equal(
      deezer.searchUrl('song', parseSearchTerms('artist:Daft Punk track:One More Time'), ''),
      'https://api.deezer.com/search?limit=50&q=artist%3ADaft%20Punk%20track%3AOne%20More%20Time',
    );
    assert.equal(
      deezer.searchUrl('album', parseSearchTerms('album:Discovery artist:Daft Punk'), ''),
      'https://api.deezer.com/search?limit=1&q=album:Discovery%20artist%3ADaft%20Punk',
    );
    assert.equal(
      deezer.searchUrl('station', parseSearchTerms('Daft Punk'), ''),
      'https://api.deezer.com/search?limit=1&q=artist:Daft%20Punk',
    );
    assert.throws(() => deezer.searchUrl('playlist', parseSearchTerms('x'), ''), /cannot search/);
    assert.throws(() => deezer.parse('playlist', { data: [] }), /cannot search/);
  });

  it('uses the account id as the service token for tracks, albums and stations', () => {
    const deezer = createDeezerService();
    const tracks = deezer.parse('song', { data: [song, { ...song, id: 10 }] }).tracks(account);
    assert.equal(tracks.count, 1);
    assert.equal(tracks.queueTracks[0]?.uri, 'x-sonos-http:tr%3a9.mp3?sid=2&flags=8224&sn=7');
    assert.match(
      tracks.queueTracks[0]?.metadata ?? '',
      /id="00032020tr%3a9" parentID="00020000search-track:song a"/,
    );
    assert.match(tracks.queueTracks[0]?.metadata ?? '', /SA_RINCON519_deezer@example.com/);

    const album = deezer.parse('album', { data: [song] }).first(account);
    assert.equal(album.uri, 'x-rincon-cpcontainer:0004006calbum-5');
    assert.match(album.metadata, /id="0004006calbum-5" parentID="00020000search-album:5"/);

    const station = deezer.parse('station', { data: [song] }).first(account);
    assert.equal(station.uri, 'x-sonosapi-radio:radio-artist-1?sid=2&flags=104&sn=7');
    assert.match(station.metadata, /<dc:title>Art Radio<\/dc:title>/);
    assert.match(station.metadata, /parentID="00050064artist-1"/);
  });

  it('uses the flac track prefix for Deezer Elite', () => {
    const elite = createDeezerService({ flac: true, name: 'elite' });
    assert.equal(elite.name, 'elite');
    const track = elite.parse('song', { data: [song] }).tracks(account).queueTracks[0];
    assert.match(track?.metadata ?? '', /id="00032020tr-flac%3a9"/);
  });

  it('reports empty results', () => {
    const empty = createDeezerService().parse('song', { data: [] });
    assert.equal(empty.empty, true);
    assert.throws(() => empty.first(account), /No matches/);
  });
});
