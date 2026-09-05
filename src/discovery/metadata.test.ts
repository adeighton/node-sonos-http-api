import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { describe, it } from 'node:test';

import { readFixture, readJsonFixture, fixturePath } from '../testing/fixtures.ts';
import {
  parseBrowseItems,
  parseCurrentTrackMetadata,
  parseEnqueuedMetadata,
  parseNextTrackMetadata,
} from './metadata.ts';
import type { LastChangeData } from './types.ts';
import { firstXmlTag, nodeText } from './xml.ts';

async function browseResultDidl(fixture: string): Promise<string> {
  const result = await firstXmlTag(createReadStream(fixturePath(fixture)), 'result');
  return nodeText(result) ?? '';
}

describe('parseCurrentTrackMetadata', () => {
  it('parses a queue track', async () => {
    const lastChange = readJsonFixture<LastChangeData>('avtransportlastchange.json');
    const track = await parseCurrentTrackMetadata(lastChange.currenttrackmetadata?.val);

    assert.deepEqual(track, {
      artist: 'Johannes Brahms',
      title: 'Intermezzo No. 3 in C-sharp minor, Op. 117 - Andante con moto',
      album: 'Glenn Gould plays Brahms: 4 Ballades op. 10; 2 Rhapsodies op. 79; 10 Intermezzi',
      albumArtUri:
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a5qAFqkXoQd2RfjZ2j1ay0w%3fsid%3d9%26flags%3d8224%26sn%3d9',
      duration: 318,
      uri: 'x-sonos-spotify:spotify%3atrack%3a5qAFqkXoQd2RfjZ2j1ay0w?sid=9&flags=8224&sn=9',
      trackUri: 'x-sonos-spotify:spotify%3atrack%3a5qAFqkXoQd2RfjZ2j1ay0w?sid=9&flags=8224&sn=9',
      type: 'track',
      stationName: '',
    });
  });

  it('uses the stream content as title for radio and keeps missing fields undefined', async () => {
    const lastChange = readJsonFixture<LastChangeData>('avtransportlastchange_radio.json');
    const track = await parseCurrentTrackMetadata(lastChange.currenttrackmetadata?.val);

    assert.equal(track.title, 'Leona Lewis - Bleeding Love');
    assert.equal(track.album, undefined);
    assert.equal(track.artist, undefined);
    assert.equal(track.duration, 0);
    assert.equal(track.uri, 'x-sonosapi-stream:s17553?sid=254&flags=8224&sn=0');
  });

  it('returns an empty track for missing metadata', async () => {
    const track = await parseCurrentTrackMetadata(undefined);
    assert.equal(track.title, '');
    assert.equal(track.uri, '');
    assert.equal(track.type, 'track');
  });
});

describe('parseNextTrackMetadata', () => {
  it('parses the next track without track-specific fields', async () => {
    const lastChange = readJsonFixture<LastChangeData>('avtransportlastchange.json');
    const track = await parseNextTrackMetadata(lastChange['r:nexttrackmetadata']?.val);

    assert.deepEqual(track, {
      artist: 'Coheed and Cambria',
      title: 'Here To Mars',
      album: 'The Color Before The Sun',
      albumArtUri:
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a0Ap3aOVU7LItcHIFiRF8lY%3fsid%3d9%26flags%3d8224%26sn%3d9',
      duration: 241,
      uri: 'x-sonos-spotify:spotify%3atrack%3a0Ap3aOVU7LItcHIFiRF8lY?sid=9&flags=8224&sn=9',
    });
  });

  it('returns an empty next track when there is none', async () => {
    assert.deepEqual(await parseNextTrackMetadata(''), {
      artist: '',
      title: '',
      album: '',
      albumArtUri: '',
      duration: 0,
      uri: '',
    });
  });
});

describe('parseEnqueuedMetadata', () => {
  it('extracts the title of the enqueued container', async () => {
    const lastChange = readJsonFixture<LastChangeData>('avtransportlastchange.json');
    const enqueued = await parseEnqueuedMetadata(lastChange['r:enqueuedtransporturimetadata']?.val);

    assert.deepEqual(enqueued, { title: 'Peaceful Piano', albumArtURI: undefined });
  });

  it('extracts album art when a DLNA server provides it', async () => {
    const lastChange = readJsonFixture<LastChangeData>('avtransportlastchange_subsonic.json');
    const enqueued = await parseEnqueuedMetadata(lastChange['r:enqueuedtransporturimetadata']?.val);

    assert.equal(
      enqueued.albumArtURI,
      'http://192.168.200.20:4040/coverArt.view?id=9381&auth=1583337699&size=300',
    );
  });

  it('returns an empty object for missing metadata', async () => {
    assert.deepEqual(await parseEnqueuedMetadata(undefined), {});
  });
});

describe('parseBrowseItems', () => {
  it('parses queue items with every field present', async () => {
    const items = await parseBrowseItems(await browseResultDidl('queue.xml'));

    assert.ok(items.length > 1);
    assert.deepEqual(items[0], {
      uri: 'x-sonos-spotify:spotify%3atrack%3a2uAWmcvujYUNTPCIb2VYKH?sid=9&flags=8224&sn=2',
      artist: 'Deftones',
      metadata: undefined,
      albumTrackNumber: undefined,
      title: 'Prayers/Triangles',
      album: 'Prayers/Triangles',
      albumArtUri:
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a2uAWmcvujYUNTPCIb2VYKH%3fsid%3d9%26flags%3d8224%26sn%3d2',
    });
  });

  it('parses containers, keeping multiple album art uris as an array', async () => {
    const items = await parseBrowseItems(await browseResultDidl('playlists.xml'));

    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      uri: 'file:///jffs/settings/savedqueues.rsq#2',
      title: 'Morgon',
      artist: undefined,
      albumArtUri: [
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a35N1AduT1LDo3deLfYniTY%3fsid%3d9%26flags%3d0',
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a1MQYow43CGLYMECVSjTpCM%3fsid%3d9%26flags%3d0',
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a4QWMYALvB1m4Um8ytjZR9m%3fsid%3d9%26flags%3d0',
        '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a1d62ECx2DlaBmhOLymrVGc%3fsid%3d9%26flags%3d0',
      ],
    });
  });

  it('returns no items for an empty result', async () => {
    assert.deepEqual(await parseBrowseItems(undefined), []);
    assert.deepEqual(await parseBrowseItems(''), []);
  });

  it('survives the raw XML fixture being fed as a whole', async () => {
    // A SOAP envelope has no <item> or <container>, so nothing is collected.
    assert.deepEqual(await parseBrowseItems(readFixture('addURIToQueue.xml')), []);
  });
});
