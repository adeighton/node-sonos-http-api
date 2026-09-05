import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { fixturePath } from '../testing/fixtures.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { flushPromises } from '../testing/async.ts';
import { LibraryIndex } from './library.ts';
import { MusicSearch, looksLikeArtistSearch, parseAccount } from './search.ts';
import type { MusicSearchDeps } from './search.ts';
import { SPOTIFY_TOKEN_URL } from './spotify.ts';
import type { TrackList } from './types.ts';

const STATUS_XML =
  '<Accounts><Account Type="2311" SerialNum="3"><UN>spotify-user</UN></Account><Account Type="52231" SerialNum="4"><UN>apple-user</UN></Account><Account Type="519" SerialNum="0"><UN>deezer-user</UN></Account></Accounts>';

function track(name: string, artist = 'Daft Punk'): TrackList['queueTracks'][number] {
  return { trackName: name, artistName: artist, uri: `x-sonos-http:${name}`, metadata: '' };
}

function setup(
  overrides: Partial<MusicSearchDeps> = {},
  routes: Parameters<typeof fakeFetch>[0] = {},
) {
  const system = new FakeSystem();
  system.availableServices = {
    Spotify: { id: 9, capabilities: 0, type: 2311 },
    'Apple Music': { id: 204, capabilities: 0, type: 52231 },
    Deezer: { id: 2, capabilities: 0, type: 519 },
  };
  const kitchen = createTestPlayer({ system, roomName: 'Kitchen' });
  system.addStandalone(kitchen.player);
  const fetch = fakeFetch({
    'https://ipinfo.io/json': { body: { country: 'SE' } },
    [SPOTIFY_TOKEN_URL]: { body: { access_token: 'tok', expires_in: 3600 } },
    ...routes,
  });
  const http = ({ url }: { url: string }) => {
    assert.equal(url, `${kitchen.player.baseUrl}/status/accounts`);
    return Promise.resolve({ body: STATUS_XML });
  };
  const logs = captureLogs();
  const library = new LibraryIndex({ cacheDir: '/nonexistent' });
  const search = new MusicSearch({
    http,
    fetch: fetch.fetch,
    library,
    spotify: { clientId: 'id', clientSecret: 'secret' },
    logger: logs.logger,
    random: () => 0,
    ...overrides,
  });
  return { system, kitchen, fetch, search, logs, library };
}

describe('parseAccount', () => {
  it('reads the user name and serial for a service type', () => {
    assert.deepEqual(parseAccount(STATUS_XML, 2311), { accountId: 'spotify-user', accountSN: '3' });
    assert.deepEqual(parseAccount(STATUS_XML, 52231), { accountId: 'apple-user', accountSN: '4' });
    assert.deepEqual(parseAccount(STATUS_XML, 999), { accountId: '', accountSN: '' });
    assert.deepEqual(parseAccount('<Accounts><Account Type="2311"/></Accounts>', 2311), {
      accountId: '',
      accountSN: '',
    });
  });
});

describe('looksLikeArtistSearch', () => {
  it('treats many distinct songs by few artists as an artist search', () => {
    const many = { count: 3, isArtist: false, queueTracks: [track('A'), track('B'), track('C')] };
    assert.equal(looksLikeArtistSearch(many), true);
    const one = { count: 1, isArtist: false, queueTracks: [track('A')] };
    assert.equal(looksLikeArtistSearch(one), false);
    const mixed = {
      count: 3,
      isArtist: false,
      queueTracks: [track('A', 'X'), track('B', 'Y'), track('C', 'Z')],
    };
    assert.equal(looksLikeArtistSearch(mixed), false);
  });
});

describe('MusicSearch', () => {
  it('validates the service, type and term', async () => {
    const { search, kitchen, system } = setup();
    assert.deepEqual(search.serviceNames, ['apple', 'spotify', 'deezer', 'elite', 'library']);
    await assert.rejects(
      search.run(kitchen.player, system, ['tidal', 'song', 'x']),
      BadRequestError,
    );
    await assert.rejects(
      search.run(kitchen.player, system, ['spotify', 'video', 'x']),
      BadRequestError,
    );
    await assert.rejects(search.run(kitchen.player, system, ['spotify', 'load']), BadRequestError);
    await assert.rejects(
      search.run(kitchen.player, system, ['apple', 'playlist', 'x']),
      BadRequestError,
    );
    await assert.rejects(search.run(kitchen.player, system, ['apple', 'song']), BadRequestError);
    await assert.rejects(
      search.run(kitchen.player, system, ['apple', 'song', '']),
      BadRequestError,
    );
    assert.equal(kitchen.soap.calls.length, 0);
  });

  it('plays a station straight away with the account from the player', async () => {
    const { search, kitchen, system, fetch } = setup(
      {},
      {
        'https://api.spotify.com/v1/search?type=artist*': {
          body: {
            artists: { items: [{ id: 'art1', name: 'Daft Punk', uri: 'spotify:artist:art1' }] },
          },
        },
      },
    );

    await search.run(kitchen.player, system, ['spotify', 'station', 'Daft Punk']);

    const searchCall = fetch.calls.find((call) => call.url.includes('type=artist'));
    assert.ok(searchCall);
    assert.equal(
      searchCall.url,
      'https://api.spotify.com/v1/search?type=artist&limit=1&q=Daft%20Punk&market=SE',
    );
    assert.equal(new Headers(searchCall.init?.headers).get('authorization'), 'Bearer tok');
    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [SOAP_ACTIONS.SetAVTransportURI, SOAP_ACTIONS.Play],
    );
    assert.equal(
      kitchen.soap.calls[0]?.values?.uri,
      'x-sonosapi-radio:spotify%3aartistRadio%3aart1?sid=9&amp;flags=8300&amp;sn=14',
    );

    // The country is looked up once per process.
    await search.run(kitchen.player, system, ['spotify', 'station', 'Daft Punk']);
    assert.equal(fetch.calls.filter((call) => call.url === 'https://ipinfo.io/json').length, 1);
  });

  it('falls back to US when the country lookup fails', async () => {
    const { search, kitchen, system, fetch, logs } = setup(
      {},
      {
        'https://ipinfo.io/json': { status: 500, body: 'down' },
        'https://itunes.apple.com/search?media=music&limit=1&entity=album*': {
          body: {
            resultCount: 1,
            results: [{ collectionId: 5, collectionName: 'Discovery', artistName: 'Daft Punk' }],
          },
        },
      },
    );

    await search.run(kitchen.player, system, ['apple', 'album', 'Discovery']);

    assert.ok(fetch.calls.some((call) => call.url.endsWith('&country=US')));
    assert.ok(logs.messages().some((message) => message.includes('assuming US')));
    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [
        SOAP_ACTIONS.RemoveAllTracksFromQueue,
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.Play,
      ],
    );
    assert.equal(kitchen.soap.calls[1]?.values?.uri, `x-rincon-queue:${kitchen.player.uuid}#0`);
    assert.equal(kitchen.soap.calls[2]?.values?.uri, 'x-rincon-cpcontainer:0004206calbum%3a5');
    assert.deepEqual(
      [
        kitchen.soap.calls[2]?.values?.enqueueAsNext,
        kitchen.soap.calls[2]?.values?.desiredFirstTrackNumberEnqueued,
      ],
      [1, 1],
    );
  });

  it('reports failed searches and empty results', async () => {
    const { search, kitchen, system } = setup(
      {},
      {
        'https://api.deezer.com/search?limit=1&q=artist:Nobody': { body: { data: [] } },
        'https://api.deezer.com/search?limit=1&q=album:Broken': { status: 503, body: 'x' },
      },
    );
    await assert.rejects(
      search.run(kitchen.player, system, ['deezer', 'station', 'Nobody']),
      NotFoundError,
    );
    await assert.rejects(
      search.run(kitchen.player, system, ['deezer', 'album', 'Broken']),
      /status 503/,
    );
    assert.equal(kitchen.soap.calls.length, 0);
  });

  it('inserts a single song after the current track and skips to it', async () => {
    const { search, kitchen, system } = setup(
      {},
      {
        'https://api.deezer.com/search?limit=50*': {
          body: { data: [{ id: 9, title: 'Blue Monday', artist: { id: 1, name: 'New Order' } }] },
        },
      },
    );
    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      currenttrack: { val: '3' },
    });
    kitchen.soap.calls.length = 0;
    kitchen.soap.queueResponse(createReadStream(fixturePath('queue.xml'))); // Browse Q:0

    await search.run(kitchen.player, system, ['deezer', 'song', 'Blue Monday']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [
        SOAP_ACTIONS.Browse,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.Next,
        SOAP_ACTIONS.Play,
      ],
    );
    assert.deepEqual(kitchen.soap.calls[0]?.values, { objectId: 'Q:0', startIndex: 0, limit: 1 });
    assert.equal(kitchen.soap.calls[1]?.values?.desiredFirstTrackNumberEnqueued, 4);
    assert.equal(
      kitchen.soap.calls[1]?.values?.uri,
      'x-sonos-http:tr%3a9.mp3?sid=2&amp;flags=8224&amp;sn=0',
    );
  });

  it('starts an empty queue at track one without skipping', async () => {
    const { search, kitchen, system } = setup(
      {},
      {
        'https://api.deezer.com/search?limit=50*': {
          body: { data: [{ id: 9, title: 'Blue Monday', artist: { id: 1, name: 'New Order' } }] },
        },
      },
    );
    kitchen.soap.queueResponse(
      Readable.from([
        '<s:Envelope><s:Body><u:BrowseResponse><Result></Result><NumberReturned>0</NumberReturned><TotalMatches>0</TotalMatches></u:BrowseResponse></s:Body></s:Envelope>',
      ]),
    );

    await search.run(kitchen.player, system, ['deezer', 'song', 'Blue Monday']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [
        SOAP_ACTIONS.Browse,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.Play,
      ],
    );
    assert.equal(kitchen.soap.calls[1]?.values?.desiredFirstTrackNumberEnqueued, 1);
  });

  it('replaces the queue for an artist search and enqueues the rest in the background', async () => {
    const { search, kitchen, system, logs } = setup(
      {},
      {
        'https://api.deezer.com/search?limit=50*': {
          body: {
            data: [
              { id: 1, title: 'One More Time', artist: { id: 1, name: 'Daft Punk' } },
              { id: 2, title: 'Aerodynamic', artist: { id: 1, name: 'Daft Punk' } },
              { id: 3, title: 'Digital Love', artist: { id: 1, name: 'Daft Punk' } },
            ],
          },
        },
      },
    );
    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      currentplaymode: { val: 'SHUFFLE_NOREPEAT' },
    });
    kitchen.soap.calls.length = 0;

    await search.run(kitchen.player, system, ['deezer', 'song', 'artist:Daft Punk']);
    await flushPromises();

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [
        SOAP_ACTIONS.RemoveAllTracksFromQueue,
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.Play,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.AddURIToQueue,
      ],
    );
    // random() always returns 0, so the shuffle rotates the list deterministically.
    assert.deepEqual(
      kitchen.soap.calls
        .filter((call) => call.action === SOAP_ACTIONS.AddURIToQueue)
        .map((call) => call.values?.uri),
      [
        'x-sonos-http:tr%3a2.mp3?sid=2&amp;flags=8224&amp;sn=0',
        'x-sonos-http:tr%3a3.mp3?sid=2&amp;flags=8224&amp;sn=0',
        'x-sonos-http:tr%3a1.mp3?sid=2&amp;flags=8224&amp;sn=0',
      ],
    );
    assert.deepEqual(
      kitchen.soap.calls
        .filter((call) => call.action === SOAP_ACTIONS.AddURIToQueue)
        .map((call) => call.values?.desiredFirstTrackNumberEnqueued),
      [1, 2, 3],
    );
    assert.equal(
      logs.messages().filter((message) => message.includes('could not enqueue')).length,
      0,
    );
  });

  it('keeps the search order without shuffle and logs a failed background enqueue', async () => {
    const { search, kitchen, system, logs } = setup(
      {},
      {
        'https://api.deezer.com/search?limit=50*': {
          body: {
            data: [
              { id: 1, title: 'A', artist: { id: 1, name: 'Daft Punk' } },
              { id: 2, title: 'B', artist: { id: 1, name: 'Daft Punk' } },
              { id: 3, title: 'C', artist: { id: 1, name: 'Daft Punk' } },
            ],
          },
        },
      },
    );
    kitchen.soap.queueResponse(Readable.from([])); // RemoveAllTracksFromQueue
    kitchen.soap.queueResponse(Readable.from([])); // SetAVTransportURI
    kitchen.soap.queueResponse(Readable.from([])); // AddURIToQueue
    kitchen.soap.queueResponse(Readable.from([])); // Play
    kitchen.soap.queueFailure(new Error('boom')); // background AddURIToQueue

    await search.run(kitchen.player, system, ['deezer', 'song', 'Daft Punk']);
    await flushPromises();

    const added = kitchen.soap.calls.filter((call) => call.action === SOAP_ACTIONS.AddURIToQueue);
    assert.deepEqual(
      added.map((call) => call.values?.uri),
      [
        'x-sonos-http:tr%3a1.mp3?sid=2&amp;flags=8224&amp;sn=0',
        'x-sonos-http:tr%3a2.mp3?sid=2&amp;flags=8224&amp;sn=0',
      ],
    );
    assert.ok(logs.messages().includes('could not enqueue track'));
  });

  it('loads, validates and searches the local library', async () => {
    await withTempDir(async (dir) => {
      const library = new LibraryIndex({ cacheDir: dir, randomQueueLimit: 5 });
      const { search, kitchen, system } = setup({ library });
      const browse = kitchen.player.browse.bind(kitchen.player);
      kitchen.player.browse = (objectId, startIndex, limit) => {
        if (objectId !== 'A:TRACKS') {
          return browse(objectId, startIndex, limit);
        }

        return Promise.resolve({
          startIndex: 0,
          numberReturned: 2,
          totalMatches: 2,
          items: [
            {
              uri: 'x-file-cifs://nas/a.flac',
              title: 'One More Time',
              artist: 'Daft Punk',
              album: 'Discovery',
              albumTrackNumber: '1',
            },
            {
              uri: 'x-file-cifs://nas/b.flac',
              title: 'Aerodynamic',
              artist: 'Daft Punk',
              album: 'Discovery',
              albumTrackNumber: '2',
            },
          ],
        });
      };

      // Searching before the library is loaded loads it instead.
      assert.deepEqual(await search.run(kitchen.player, system, ['library', 'song', 'x']), {
        status: 'success',
        message: 'Library loaded: 2 tracks',
      });
      assert.deepEqual(await search.run(kitchen.player, system, ['library', 'load']), {
        status: 'success',
        message: 'Library loaded: 2 tracks',
      });
      await assert.rejects(
        search.run(kitchen.player, system, ['library', 'station', 'x']),
        BadRequestError,
      );
      await assert.rejects(
        search.run(kitchen.player, system, ['library', 'song']),
        BadRequestError,
      );
      await assert.rejects(
        search.run(kitchen.player, system, ['library', 'song', 'zzzzzzzz']),
        NotFoundError,
      );

      await search.run(kitchen.player, system, ['library', 'album', 'Discovery']);
      await flushPromises();
      assert.deepEqual(
        kitchen.soap.calls.map((call) => call.action),
        [
          SOAP_ACTIONS.RemoveAllTracksFromQueue,
          SOAP_ACTIONS.SetAVTransportURI,
          SOAP_ACTIONS.AddURIToQueue,
          SOAP_ACTIONS.Play,
          SOAP_ACTIONS.AddURIToQueue,
        ],
      );
      assert.equal(kitchen.soap.calls[2]?.values?.uri, 'x-file-cifs://nas/a.flac');

      kitchen.soap.calls.length = 0;
      kitchen.soap.queueResponse(
        Readable.from([
          '<s:Envelope><s:Body><u:BrowseResponse><Result></Result><NumberReturned>0</NumberReturned><TotalMatches>0</TotalMatches></u:BrowseResponse></s:Body></s:Envelope>',
        ]),
      );
      await search.run(kitchen.player, system, ['library', 'song', 'Aerodynamic']);
      assert.equal(kitchen.soap.calls[0]?.action, SOAP_ACTIONS.Browse);
      assert.equal(kitchen.soap.calls[1]?.values?.uri, 'x-file-cifs://nas/b.flac');
    });
  });
});
