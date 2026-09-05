import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import Fuse from 'fuse.js';
import { z } from 'zod';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { didlItem } from './types.ts';
import type { QueueTrack, TrackList, UriAndMetadata } from './types.ts';

export const LIBRARY_VERSION = 1.4;
const LIBRARY_TOKEN = 'RINCON_AssociatedZPUDN';
const TRACK_CLASS = 'object.item.audioItem.musicTrack';

const trackSchema = z.looseObject({
  artistTrackSearch: z.string(),
  artistAlbumSearch: z.string(),
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string(),
  albumTrackNumber: z.string().optional(),
  uri: z.string(),
  metadata: z.string(),
});
export type LibraryTrack = z.infer<typeof trackSchema>;

const librarySchema = z.looseObject({
  version: z.number(),
  tracks: z.looseObject({ items: z.array(trackSchema) }),
});

/** What the library needs to crawl a player's music library. */
export interface LibraryBrowser {
  browse(
    objectId: string,
    startIndex: number,
    limit: number,
  ): Promise<{
    startIndex: number;
    numberReturned: number;
    totalMatches: number;
    items: Array<{
      uri: string;
      title?: string | undefined;
      artist?: string | undefined;
      album?: string | undefined;
      albumTrackNumber?: string | undefined;
    }>;
  }>;
}

export interface LibraryIndexOptions {
  cacheDir: string;
  randomQueueLimit?: number;
  logger?: Logger;
}

function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }

  return copy;
}

/**
 * A fuzzy-searchable index of the local music library (NAS shares), crawled from a player and
 * cached in `cache/library.json` so restarts do not need to crawl again.
 */
export class LibraryIndex {
  readonly #file: string;
  readonly #logger: Logger;
  readonly #randomQueueLimit: number;
  #tracks: LibraryTrack[] = [];
  #byTrack: Fuse<LibraryTrack> | undefined;
  #byAlbum: Fuse<LibraryTrack> | undefined;
  #loading: Promise<string> | undefined;

  constructor(options: LibraryIndexOptions) {
    this.#file = join(options.cacheDir, 'library.json');
    this.#logger = options.logger ?? silentLogger;
    this.#randomQueueLimit = options.randomQueueLimit ?? 50;
  }

  get isLoaded(): boolean {
    return this.#byTrack !== undefined;
  }

  get size(): number {
    return this.#tracks.length;
  }

  /** Loads a previously crawled library from the cache file, ignoring older formats. */
  async readCache(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch {
      return false;
    }

    const parsed = librarySchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.version < LIBRARY_VERSION) {
      this.#logger.info({ file: this.#file }, 'ignoring library cache in an older format');
      return false;
    }

    this.#index(parsed.data.tracks.items);
    return true;
  }

  /** Crawls every track through the player and rebuilds the index; concurrent calls share one crawl. */
  load(player: LibraryBrowser): Promise<string> {
    this.#loading ??= this.#crawl(player).finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  /** Album search results (every track of the best album), or a shuffled selection of matching songs. */
  search(type: 'album' | 'song', term: string, random?: () => number): LibraryTrack[] {
    if (!this.#byTrack || !this.#byAlbum) {
      throw new Error(
        'The music library has not been loaded yet; call /musicsearch/library/load first',
      );
    }

    if (type === 'album') {
      return this.#byAlbum.search(term).map((result) => result.item);
    }

    return shuffle(
      this.#byTrack.search(term).map((result) => result.item),
      random,
    ).slice(0, this.#randomQueueLimit);
  }

  /** Turns search results into a playable list; albums keep their track order. */
  tracks(type: 'album' | 'song', results: LibraryTrack[]): TrackList {
    const albumName = results[0]?.albumName;
    const seen = new Set<string>();
    const queueTracks: QueueTrack[] = [];
    for (const track of results) {
      if (queueTracks.length >= this.#randomQueueLimit) {
        break;
      }

      if (type === 'song') {
        if (seen.has(track.trackName)) {
          continue;
        }

        seen.add(track.trackName);
      } else if (track.albumName !== albumName) {
        continue;
      }

      queueTracks.push({
        trackName: track.trackName,
        artistName: track.artistName,
        albumTrackNumber: track.albumTrackNumber,
        uri: track.uri,
        metadata: track.metadata,
      });
    }

    if (type === 'album') {
      queueTracks.sort((a, b) =>
        a.artistName !== b.artistName
          ? a.artistName.localeCompare(b.artistName)
          : Number(a.albumTrackNumber ?? 0) - Number(b.albumTrackNumber ?? 0),
      );
    }

    return { count: queueTracks.length, isArtist: type === 'album', queueTracks };
  }

  first(results: LibraryTrack[]): UriAndMetadata {
    const track = results[0];
    if (!track) {
      throw new Error('No matches were found');
    }

    return { uri: track.uri, metadata: track.metadata };
  }

  async #crawl(player: LibraryBrowser): Promise<string> {
    this.#logger.info('loading the music library');
    const items: LibraryTrack[] = [];
    let startIndex = 0;
    for (;;) {
      const chunk = await player.browse('A:TRACKS', startIndex, 0);
      for (const item of chunk.items) {
        if (
          item.uri &&
          item.artist !== undefined &&
          item.album !== undefined &&
          item.title !== undefined
        ) {
          const id = `S:${item.uri.slice(item.uri.indexOf(':') + 1)}`;
          const parent = `A:ALBUMARTIST/${encodeURIComponent(item.artist)}/${encodeURIComponent(item.album)}`;
          items.push({
            artistTrackSearch: `${item.artist} ${item.title}`,
            artistAlbumSearch: `${item.artist} ${item.album}`,
            trackName: item.title,
            artistName: item.artist,
            albumName: item.album,
            albumTrackNumber: item.albumTrackNumber,
            uri: item.uri,
            metadata: didlItem(id, parent, '', TRACK_CLASS, LIBRARY_TOKEN),
          });
        }
      }

      startIndex = chunk.startIndex + chunk.numberReturned;
      this.#logger.info({ loaded: startIndex, total: chunk.totalMatches }, 'library tracks');
      if (chunk.numberReturned === 0 || startIndex >= chunk.totalMatches) {
        break;
      }
    }

    await writeFile(this.#file, JSON.stringify({ version: LIBRARY_VERSION, tracks: { items } }));
    this.#index(items);
    return `Library loaded: ${items.length} tracks`;
  }

  #index(tracks: LibraryTrack[]): void {
    this.#tracks = tracks;
    const options = { threshold: 0.2, ignoreLocation: true };
    this.#byTrack = new Fuse(tracks, {
      ...options,
      keys: ['artistTrackSearch', 'artistName', 'trackName'],
    });
    this.#byAlbum = new Fuse(tracks, {
      ...options,
      keys: ['artistAlbumSearch', 'albumName', 'artistName'],
    });
  }
}
