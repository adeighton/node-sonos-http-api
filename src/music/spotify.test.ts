import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../http/errors.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { SPOTIFY_TOKEN_URL, createSpotifyService } from './spotify.ts';
import { parseSearchTerms } from './terms.ts';
import type { ServiceAccount } from './types.ts';

const account: ServiceAccount = {
  sid: 9,
  serviceType: 2311,
  accountId: 'spotify@example.com',
  accountSN: '2',
  country: 'SE',
};

describe('createSpotifyService', () => {
  it('builds Web API search urls with the market', () => {
    const spotify = createSpotifyService();
    assert.equal(spotify.needsCountry, true);
    assert.equal(
      spotify.searchUrl('song', parseSearchTerms('artist:Daft Punk track:One More Time'), 'SE'),
      'https://api.spotify.com/v1/search?type=track&limit=50&q=artist%3ADaft%20Punk%20track%3AOne%20More%20Time&market=SE',
    );
    assert.equal(
      spotify.searchUrl('playlist', parseSearchTerms('Chill Mix'), 'US'),
      'https://api.spotify.com/v1/search?type=playlist&q=Chill%20Mix&market=US',
    );
  });

  it('fetches a client-credentials token once and refreshes it after expiry', async () => {
    let clock = 1_000_000;
    let issued = 0;
    const { fetch, calls } = fakeFetch({
      [SPOTIFY_TOKEN_URL]: () => {
        issued += 1;
        return { body: { access_token: `token-${issued}`, expires_in: 3600 } };
      },
    });
    const spotify = createSpotifyService({
      clientId: 'id',
      clientSecret: 's3cret',
      fetch,
      now: () => clock,
    });

    assert.deepEqual(await spotify.headers(), { Authorization: 'Bearer token-1' });
    assert.deepEqual(await spotify.headers(), { Authorization: 'Bearer token-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.method, 'POST');
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(
      headers.get('authorization'),
      `Basic ${Buffer.from('id:s3cret').toString('base64')}`,
    );
    assert.equal(calls[0]?.init?.body, 'grant_type=client_credentials');

    clock += 3600 * 1000;
    assert.deepEqual(await spotify.headers(), { Authorization: 'Bearer token-2' });
  });

  it('rejects when credentials are missing or refused', async () => {
    await assert.rejects(
      createSpotifyService({ fetch: fakeFetch({}).fetch }).headers(),
      BadRequestError,
    );
    const refused = fakeFetch({ [SPOTIFY_TOKEN_URL]: { status: 401, body: 'nope' } });
    await assert.rejects(
      createSpotifyService({ clientId: 'id', clientSecret: 'x', fetch: refused.fetch }).headers(),
      /status 401/,
    );
  });

  it('filters tracks to the market and pins the account serial Sonos expects', () => {
    const spotify = createSpotifyService();
    const results = spotify.parse('song', {
      tracks: {
        items: [
          {
            id: 'abc',
            name: 'One More Time',
            uri: 'spotify:track:abc',
            artists: [{ name: 'Daft Punk' }],
            available_markets: ['SE'],
          },
          {
            id: 'def',
            name: 'Aerodynamic',
            uri: 'spotify:track:def',
            artists: [{ name: 'Daft Punk' }],
            available_markets: ['US'],
          },
          {
            id: 'ghi',
            name: 'Digital Love',
            uri: 'spotify:track:ghi',
            artists: [],
            available_markets: null,
          },
        ],
      },
    });
    assert.equal(results.empty, false);
    const tracks = results.tracks(account);
    assert.deepEqual(
      tracks.queueTracks.map((track) => [track.trackName, track.artistName, track.uri]),
      [
        [
          'One More Time',
          'Daft Punk',
          'x-sonos-spotify:spotify%3atrack%3aabc?sid=9&flags=8224&sn=14',
        ],
        ['Digital Love', '', 'x-sonos-spotify:spotify%3atrack%3aghi?sid=9&flags=8224&sn=14'],
      ],
    );
    assert.match(
      tracks.queueTracks[0]?.metadata ?? '',
      /id="00032020spotify%3atrack%3aabc" parentID="00020000track:abc"/,
    );
    assert.match(tracks.queueTracks[0]?.metadata ?? '', /SA_RINCON2311_X_#Svc2311-0-Token/);
  });

  it('builds album, station and playlist containers', () => {
    const spotify = createSpotifyService();
    const album = spotify
      .parse('album', {
        albums: { items: [{ id: 'alb1', name: 'Discovery', uri: 'spotify:album:alb1' }] },
      })
      .first(account);
    assert.equal(album.uri, 'x-rincon-cpcontainer:0004206cspotify%3Aalbum%3Aalb1');
    assert.match(
      album.metadata,
      /id="0004206cspotify%3aalbum%3aalb1" parentID="00020000album:discovery"/,
    );

    const station = spotify
      .parse('station', {
        artists: { items: [{ id: 'art1', name: 'Daft Punk', uri: 'spotify:artist:art1' }] },
      })
      .first(account);
    assert.equal(
      station.uri,
      'x-sonosapi-radio:spotify%3aartistRadio%3aart1?sid=9&flags=8300&sn=14',
    );
    assert.match(station.metadata, /<dc:title>Daft Punk Radio<\/dc:title>/);
    assert.match(station.metadata, /parentID="00052064spotify%3aartist%3aart1"/);

    const playlist = spotify
      .parse('playlist', {
        playlists: { items: [null, { id: 'pl1', name: 'Mix', uri: 'spotify:playlist:pl1' }] },
      })
      .first(account);
    assert.equal(playlist.uri, 'x-rincon-cpcontainer:0006206cspotify%3Aplaylist%3Apl1');
    assert.match(playlist.metadata, /object\.container\.playlistContainer/);

    const empty = spotify.parse('album', { albums: { items: [] } });
    assert.equal(empty.empty, true);
    assert.throws(() => empty.first(account), /No matches/);
    assert.equal(spotify.parse('song', {}).empty, true);
  });
});
