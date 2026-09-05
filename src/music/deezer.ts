import { z } from 'zod';

import { didlItem, dedupeTracks, stationName } from './types.ts';
import type { MusicService, ParsedResults, SearchType, ServiceAccount } from './types.ts';

const SEARCH_URLS = {
  album: 'https://api.deezer.com/search?limit=1&q=album:',
  song: 'https://api.deezer.com/search?limit=50&q=',
  station: 'https://api.deezer.com/search?limit=1&q=artist:',
} as const;

const PARENT = {
  album: '00020000search-album:',
  song: '00020000search-track:',
  station: '00050064artist-',
} as const;
const OBJECT_CLASS = {
  album: 'object.container.album.musicAlbum.#DEFAULT',
  song: 'object.item.audioItem.musicTrack.#DEFAULT',
  station: 'object.item.audioItem.audioBroadcast.#DEFAULT',
} as const;

type DeezerType = keyof typeof SEARCH_URLS;

const responseSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.number(),
      title: z.string().optional(),
      artist: z.looseObject({ id: z.number(), name: z.string() }).optional(),
      album: z.looseObject({ id: z.number(), title: z.string() }).optional(),
    }),
  ),
});

function isDeezerType(type: SearchType): type is DeezerType {
  return type in SEARCH_URLS;
}

export interface DeezerOptions {
  /** Deezer Elite (FLAC) accounts use a different track prefix. */
  flac?: boolean;
  name?: string;
}

/** Deezer (and Deezer Elite), searched through the public Deezer API. */
export function createDeezerService(options: DeezerOptions = {}): MusicService {
  const songPrefix = options.flac ? '00032020tr-flac%3a' : '00032020tr%3a';
  const metaStart = {
    album: '0004006calbum-',
    song: songPrefix,
    station: '000c0068radio-artist-',
  } as const;

  const token = (account: ServiceAccount): string =>
    `SA_RINCON${account.serviceType}_${account.accountId}`;
  const uri = (type: DeezerType, id: string, account: ServiceAccount): string => {
    switch (type) {
      case 'album':
        return `x-rincon-cpcontainer:0004006calbum-${id}`;
      case 'song':
        return `x-sonos-http:tr%3a${id}.mp3?sid=${account.sid}&flags=8224&sn=${account.accountSN}`;
      case 'station':
        return `x-sonosapi-radio:radio-artist-${id}?sid=${account.sid}&flags=104&sn=${account.accountSN}`;
    }
  };
  const metadata = (
    type: DeezerType,
    id: string,
    name: string,
    title: string,
    account: ServiceAccount,
  ): string =>
    didlItem(
      id,
      `${PARENT[type]}${name}`,
      type === 'station' ? title : '',
      OBJECT_CLASS[type],
      token(account),
    );

  return {
    name: options.name ?? 'deezer',
    sonosName: 'Deezer',
    needsCountry: false,
    supports: ['album', 'song', 'station'],

    searchUrl(type, terms) {
      if (!isDeezerType(type)) {
        throw new Error(`Deezer cannot search for ${type}`);
      }

      let query: string;
      if (terms.term !== '') {
        query = terms.term;
      } else {
        query = terms.album !== '' ? `${terms.album} ` : '';
        if (terms.artist !== '') {
          query += `artist:${terms.artist}${terms.track !== '' ? ' ' : ''}`;
        }

        if (terms.track !== '') {
          query += `track:${terms.track}`;
        }
      }

      return `${SEARCH_URLS[type]}${encodeURIComponent(query)}`;
    },

    headers: () => Promise.resolve(undefined),

    parse(type, body): ParsedResults {
      if (!isDeezerType(type)) {
        throw new Error(`Deezer cannot search for ${type}`);
      }

      const response = responseSchema.parse(body);
      return {
        empty: response.data.length === 0,
        first(account) {
          const item = response.data[0];
          if (!item) {
            throw new Error('No matches were found');
          }

          const id = String(type === 'album' ? item.album?.id : item.artist?.id);
          const title =
            type === 'album' ? (item.album?.title ?? '') : `${item.artist?.name ?? ''} Radio`;
          const encodedId = encodeURIComponent(id);
          return {
            uri: uri(type, encodedId, account),
            metadata: metadata(
              type,
              `${metaStart[type]}${encodedId}`,
              stationName(title) && id,
              title,
              account,
            ),
          };
        },
        tracks(account) {
          const tracks = dedupeTracks(
            response.data.map((track) => {
              const id = encodeURIComponent(String(track.id));
              const title = track.title ?? '';
              return {
                trackName: title,
                artistName: track.artist?.name ?? '',
                uri: uri('song', id, account),
                metadata: metadata(
                  'song',
                  `${metaStart.song}${id}`,
                  title.toLowerCase(),
                  title,
                  account,
                ),
              };
            }),
          );
          return { count: tracks.length, isArtist: false, queueTracks: tracks };
        },
      };
    },
  };
}
