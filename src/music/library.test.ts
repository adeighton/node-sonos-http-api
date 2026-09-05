import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { LIBRARY_VERSION, LibraryIndex } from './library.ts';
import type { LibraryBrowser } from './library.ts';

interface Item {
  uri: string;
  title?: string;
  artist?: string;
  album?: string;
  albumTrackNumber?: string;
}

const ITEMS: Item[] = [
  {
    uri: 'x-file-cifs://nas/a1.flac',
    title: 'Aerodynamic',
    artist: 'Daft Punk',
    album: 'Discovery',
    albumTrackNumber: '2',
  },
  {
    uri: 'x-file-cifs://nas/a2.flac',
    title: 'One More Time',
    artist: 'Daft Punk',
    album: 'Discovery',
    albumTrackNumber: '1',
  },
  {
    uri: 'x-file-cifs://nas/b1.flac',
    title: 'Around The World',
    artist: 'Daft Punk',
    album: 'Homework',
    albumTrackNumber: '7',
  },
  {
    uri: 'x-file-cifs://nas/c1.flac',
    title: 'Blue Monday',
    artist: 'New Order',
    album: 'Substance',
    albumTrackNumber: '1',
  },
  { uri: 'x-file-cifs://nas/broken.flac', title: 'No album' },
];

/** A browser that serves ITEMS in pages of `pageSize` and records requested offsets. */
function fakeBrowser(pageSize: number): LibraryBrowser & { offsets: number[] } {
  const offsets: number[] = [];
  return {
    offsets,
    browse: (objectId, startIndex) => {
      assert.equal(objectId, 'A:TRACKS');
      offsets.push(startIndex);
      const items = ITEMS.slice(startIndex, startIndex + pageSize);
      return Promise.resolve({
        startIndex,
        numberReturned: items.length,
        totalMatches: ITEMS.length,
        items,
      });
    },
  };
}

describe('LibraryIndex', () => {
  it('crawls every page, skips incomplete items and writes the cache', async () => {
    await withTempDir(async (dir) => {
      const logs = captureLogs();
      const library = new LibraryIndex({ cacheDir: dir, logger: logs.logger });
      const browser = fakeBrowser(2);
      assert.equal(library.isLoaded, false);
      assert.throws(() => library.search('song', 'x'), /not been loaded/);

      const [first, second] = await Promise.all([library.load(browser), library.load(browser)]);

      assert.equal(first, 'Library loaded: 4 tracks');
      assert.equal(second, first);
      assert.deepEqual(browser.offsets, [0, 2, 4]);
      assert.equal(library.isLoaded, true);
      assert.equal(library.size, 4);
      const cache = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8')) as {
        version: number;
        tracks: { items: Array<{ metadata: string; uri: string }> };
      };
      assert.equal(cache.version, LIBRARY_VERSION);
      assert.equal(cache.tracks.items.length, 4);
      assert.match(
        cache.tracks.items[0]?.metadata ?? '',
        /id="S:\/\/nas\/a1.flac" parentID="A:ALBUMARTIST\/Daft%20Punk\/Discovery"/,
      );
      assert.match(cache.tracks.items[0]?.metadata ?? '', /RINCON_AssociatedZPUDN/);
      assert.ok(logs.messages().includes('loading the music library'));
    });
  });

  it('searches albums in track order and songs shuffled up to the random queue limit', async () => {
    await withTempDir(async (dir) => {
      const library = new LibraryIndex({ cacheDir: dir, randomQueueLimit: 2 });
      await library.load(fakeBrowser(10));

      const album = library.tracks('album', library.search('album', 'Discovery'));
      assert.equal(album.isArtist, true);
      assert.deepEqual(
        album.queueTracks.map((track) => track.trackName),
        ['One More Time', 'Aerodynamic'],
      );

      const songs = library.search('song', 'Daft Punk', () => 0);
      assert.equal(songs.length, 2);
      const list = library.tracks('song', songs);
      assert.equal(list.isArtist, false);
      assert.equal(list.count, 2);
      assert.ok(list.queueTracks.every((track) => track.artistName === 'Daft Punk'));

      const single = library.search('song', 'Blue Monday');
      assert.equal(library.first(single).uri, 'x-file-cifs://nas/c1.flac');
      assert.equal(library.search('song', 'zzzzzz').length, 0);
      assert.throws(() => library.first([]), /No matches/);
    });
  });

  it('reads a cached library and ignores older formats', async () => {
    await withTempDir(async (dir) => {
      const stale = new LibraryIndex({ cacheDir: dir });
      assert.equal(await stale.readCache(), false);

      await writeFile(
        join(dir, 'library.json'),
        JSON.stringify({ version: 1.0, tracks: { items: [] } }),
      );
      const logs = captureLogs();
      const old = new LibraryIndex({ cacheDir: dir, logger: logs.logger });
      assert.equal(await old.readCache(), false);
      assert.ok(logs.messages().some((message) => message.includes('older format')));

      await new LibraryIndex({ cacheDir: dir }).load(fakeBrowser(10));
      const fresh = new LibraryIndex({ cacheDir: dir });
      assert.equal(await fresh.readCache(), true);
      assert.equal(fresh.size, 4);
      assert.equal(fresh.isLoaded, true);
    });
  });
});
