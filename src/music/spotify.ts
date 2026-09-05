import { z } from 'zod';

import { BadRequestError } from '../http/errors.ts';
import { didlItem, dedupeTracks, stationName } from './types.ts';
import type {
  MusicService,
  ParsedResults,
  SearchTerms,
  SearchType,
  ServiceAccount,
} from './types.ts';

const SEARCH_URLS = {
  album: 'https://api.spotify.com/v1/search?type=album&limit=1&q=album:',
  song: 'https://api.spotify.com/v1/search?type=track&limit=50&q=',
  station: 'https://api.spotify.com/v1/search?type=artist&limit=1&q=',
  playlist: 'https://api.spotify.com/v1/search?type=playlist&q=',
} as const;

const META_START = {
  album: '0004206cspotify%3aalbum%3a',
  song: '00032020spotify%3atrack%3a',
  station: '000c206cspotify:artistRadio%3a',
  playlist: '0004206cspotify%3aplaylist%3a',
} as const;
const PARENT = {
  album: '00020000album:',
  song: '00020000track:',
  station: '00052064spotify%3aartist%3a',
  playlist: '00020000playlist:',
} as const;
const OBJECT_CLASS = {
  album: 'object.container.album.musicAlbum',
  song: 'object.item.audioItem.musicTrack',
  station: 'object.item.audioItem.audioBroadcast.#artistRadio',
  playlist: 'object.container.playlistContainer',
} as const;

export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** Sonos reports a serial number Spotify streams reject; upstream hard-coded this one. */
const SPOTIFY_ACCOUNT_SN = '14';

const itemSchema = z.looseObject({ id: z.string(), name: z.string(), uri: z.string() });
const trackSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  artists: z.array(z.looseObject({ name: z.string() })).default([]),
  available_markets: z.array(z.string()).nullable().optional(),
});
const responseSchema = z.looseObject({
  albums: z.looseObject({ items: z.array(itemSchema) }).optional(),
  artists: z.looseObject({ items: z.array(itemSchema) }).optional(),
  playlists: z.looseObject({ items: z.array(itemSchema.nullable()) }).optional(),
  tracks: z.looseObject({ items: z.array(trackSchema) }).optional(),
});
const tokenSchema = z.looseObject({
  access_token: z.string(),
  expires_in: z.number().default(3600),
});

export interface SpotifyOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function token(account: ServiceAccount): string {
  return `SA_RINCON${account.serviceType}_X_#Svc${account.serviceType}-0-Token`;
}

function uri(type: SearchType, id: string, account: ServiceAccount): string {
  switch (type) {
    case 'album':
      return `x-rincon-cpcontainer:0004206c${id}`;
    case 'song':
      return `x-sonos-spotify:spotify%3atrack%3a${id}?sid=${account.sid}&flags=8224&sn=${account.accountSN}`;
    case 'station':
      return `x-sonosapi-radio:spotify%3aartistRadio%3a${id}?sid=${account.sid}&flags=8300&sn=${account.accountSN}`;
    case 'playlist':
      return `x-rincon-cpcontainer:0006206c${id}`;
  }
}

function metadata(
  type: SearchType,
  id: string,
  name: string,
  title: string,
  account: ServiceAccount,
): string {
  return didlItem(
    id,
    `${PARENT[type]}${name}`,
    type === 'station' ? title : '',
    OBJECT_CLASS[type],
    token(account),
  );
}

/** Spotify, searched through the Web API with a cached client-credentials token. */
export function createSpotifyService(options: SpotifyOptions = {}): MusicService {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let cached: { token: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > now()) {
      return cached.token;
    }

    if (!options.clientId || !options.clientSecret) {
      throw new BadRequestError(
        'Spotify search needs spotify.clientId and spotify.clientSecret in settings.json (or SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)',
      );
    }

    const credentials = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString(
      'base64',
    );
    const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Unable to authenticate with Spotify (status ${response.status}); check the client id and secret`,
      );
    }

    const parsed = tokenSchema.parse(await response.json());
    // Refresh a minute early so a token never expires mid-search.
    cached = { token: parsed.access_token, expiresAt: now() + (parsed.expires_in - 60) * 1000 };
    return cached.token;
  }

  return {
    name: 'spotify',
    sonosName: 'Spotify',
    needsCountry: true,
    supports: ['album', 'song', 'station', 'playlist'],

    searchUrl(type: SearchType, terms: SearchTerms, country: string): string {
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

      return `${SEARCH_URLS[type]}${encodeURIComponent(query)}&market=${encodeURIComponent(country)}`;
    },

    async headers() {
      return { Authorization: `Bearer ${await accessToken()}` };
    },

    parse(type: SearchType, body: unknown): ParsedResults {
      const response = responseSchema.parse(body);
      const items =
        type === 'album'
          ? (response.albums?.items ?? [])
          : type === 'station'
            ? (response.artists?.items ?? [])
            : type === 'playlist'
              ? (response.playlists?.items ?? []).filter((item) => item !== null)
              : [];
      const tracks = response.tracks?.items ?? [];

      return {
        empty: type === 'song' ? tracks.length === 0 : items.length === 0,
        first(account) {
          const item = items[0];
          if (!item) {
            throw new Error('No matches were found');
          }

          const title = type === 'station' ? `${item.name} Radio` : item.name;
          const encodedId = encodeURIComponent(item.id);
          const name = type === 'station' ? item.id : title.toLowerCase();
          return {
            uri: uri(type, encodeURIComponent(type === 'station' ? item.id : item.uri), {
              ...account,
              accountSN: SPOTIFY_ACCOUNT_SN,
            }),
            metadata: metadata(
              type,
              `${META_START[type]}${encodedId}`,
              name,
              stationName(title) && title,
              { ...account, accountSN: SPOTIFY_ACCOUNT_SN },
            ),
          };
        },
        tracks(account) {
          const fixed = { ...account, accountSN: SPOTIFY_ACCOUNT_SN };
          const playable = tracks.filter(
            (track) =>
              !track.available_markets || track.available_markets.includes(account.country),
          );
          const queueTracks = dedupeTracks(
            playable.map((track) => {
              const id = encodeURIComponent(track.id);
              return {
                trackName: track.name,
                artistName: track.artists[0]?.name ?? '',
                uri: uri('song', id, fixed),
                metadata: metadata('song', `${META_START.song}${id}`, track.id, track.name, fixed),
              };
            }),
          );
          return { count: queueTracks.length, isArtist: false, queueTracks };
        },
      };
    },
  };
}
