import { z } from 'zod';

import { didlItem, dedupeTracks, stationName } from './types.ts';
import type {
  MusicService,
  ParsedResults,
  SearchTerms,
  SearchType,
  ServiceAccount,
} from './types.ts';

const SEARCH_URLS = {
  album:
    'https://itunes.apple.com/search?media=music&limit=1&entity=album&attribute=albumTerm&term=',
  song: 'https://itunes.apple.com/search?media=music&limit=50&entity=song&term=',
  station: 'https://itunes.apple.com/search?media=music&limit=50&entity=musicArtist&term=',
} as const;

const META_START = {
  album: '0004206calbum%3a',
  song: '00032020song%3a',
  station: '000c206cradio%3ara.',
} as const;
const PARENT = {
  album: '00020000album:',
  song: '00020000song:',
  station: '00020000radio:',
} as const;
const OBJECT_CLASS = {
  album: 'object.container.album.musicAlbum.#AlbumView',
  song: 'object.item.audioItem.musicTrack.#SongTitleWithArtistAndAlbum',
  station: 'object.item.audioItem.audioBroadcast',
} as const;

type AppleType = keyof typeof SEARCH_URLS;

const responseSchema = z.object({
  resultCount: z.number(),
  results: z.array(
    z.looseObject({
      collectionId: z.number().optional(),
      collectionName: z.string().optional(),
      artistId: z.number().optional(),
      artistName: z.string().optional(),
      trackId: z.number().optional(),
      trackName: z.string().optional(),
      isStreamable: z.boolean().optional(),
    }),
  ),
});

function token(account: ServiceAccount): string {
  return `SA_RINCON${account.serviceType}_X_#Svc${account.serviceType}-0-Token`;
}

function uri(type: AppleType, id: string, account: ServiceAccount): string {
  switch (type) {
    case 'album':
      return `x-rincon-cpcontainer:0004206calbum%3a${id}`;
    case 'song':
      return `x-sonos-http:song%3a${id}.mp4?sid=${account.sid}&flags=8224&sn=${account.accountSN}`;
    case 'station':
      return `x-sonosapi-radio:radio%3ara.${id}?sid=${account.sid}&flags=8300&sn=${account.accountSN}`;
  }
}

function metadata(
  type: AppleType,
  id: string,
  name: string,
  title: string,
  account: ServiceAccount,
): string {
  return didlItem(
    id,
    `${PARENT[type]}${name}`,
    type === 'station' ? `${title} Radio` : '',
    OBJECT_CLASS[type],
    token(account),
  );
}

function isAppleType(type: SearchType): type is AppleType {
  return type in SEARCH_URLS;
}

/** Apple Music, searched through the public iTunes search API. */
export const appleMusic: MusicService = {
  name: 'apple',
  sonosName: 'Apple Music',
  needsCountry: true,
  supports: ['album', 'song', 'station'],

  searchUrl(type: SearchType, terms: SearchTerms, country: string): string {
    if (!isAppleType(type)) {
      throw new Error(`Apple Music cannot search for ${type}`);
    }

    let query: string;
    if (terms.term !== '') {
      query = encodeURIComponent(terms.term);
    } else {
      const words = [terms.artist, type === 'album' ? terms.album : terms.track].filter(
        (w) => w !== '',
      );
      query = encodeURIComponent(words.join(' '));
      if (terms.artist !== '') {
        query += '&attribute=artistTerm';
      }

      if (terms.track !== '') {
        query += '&attribute=songTerm';
      }
    }

    return `${SEARCH_URLS[type]}${query}&country=${encodeURIComponent(country)}`;
  },

  headers: () => Promise.resolve(undefined),

  parse(type: SearchType, body: unknown): ParsedResults {
    if (!isAppleType(type)) {
      throw new Error(`Apple Music cannot search for ${type}`);
    }

    const response = responseSchema.parse(body);
    return {
      empty: response.resultCount === 0,
      first(account) {
        const item = response.results[0];
        if (!item) {
          throw new Error('No matches were found');
        }

        const id = String(
          type === 'album' ? item.collectionId : type === 'station' ? item.artistId : item.trackId,
        );
        const title =
          (type === 'album'
            ? item.collectionName
            : type === 'station'
              ? item.artistName
              : item.trackName) ?? '';
        const encodedId = encodeURIComponent(id);
        return {
          uri: uri(type, encodedId, account),
          metadata: metadata(
            type,
            `${META_START[type]}${encodedId}`,
            stationName(title),
            title,
            account,
          ),
        };
      },
      tracks(account) {
        const tracks = dedupeTracks(
          response.results
            .filter((track) => track.isStreamable && track.trackId !== undefined)
            .map((track) => {
              const id = encodeURIComponent(String(track.trackId));
              return {
                trackName: track.trackName ?? '',
                artistName: track.artistName ?? '',
                uri: uri('song', id, account),
                metadata: metadata(
                  'song',
                  `${META_START.song}${id}`,
                  String(track.trackId),
                  track.trackName ?? '',
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
