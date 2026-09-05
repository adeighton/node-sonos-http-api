/** What can be searched for on a streaming service or the local library. */
export const SEARCH_TYPES = ['album', 'song', 'station', 'playlist'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** Search terms parsed from `artist:… album:… track:…` specifiers. */
export interface SearchTerms {
  /** The raw term when no specifier was used. */
  term: string;
  artist: string;
  album: string;
  track: string;
}

/** Per-request identity of the Sonos account for a service, read from the player. */
export interface ServiceAccount {
  sid: number;
  serviceType: number;
  accountId: string;
  accountSN: string;
  country: string;
}

export interface QueueTrack {
  trackName: string;
  artistName: string;
  uri: string;
  metadata: string;
  albumTrackNumber?: string | undefined;
}

export interface TrackList {
  count: number;
  /** Many tracks by one artist (play shuffled) rather than one specific song. */
  isArtist: boolean;
  queueTracks: QueueTrack[];
}

export interface UriAndMetadata {
  uri: string;
  metadata: string;
}

/** A streaming service the music search can query. */
export interface MusicService {
  /** Short name used in urls, e.g. `spotify`. */
  readonly name: string;
  /** Name in the Sonos service list, e.g. `Spotify`. */
  readonly sonosName: string;
  /** Whether results depend on the user's country (looked up once per process). */
  readonly needsCountry: boolean;
  readonly supports: readonly SearchType[];
  searchUrl(type: SearchType, terms: SearchTerms, country: string): string;
  /** Request headers (authentication); called before every search. */
  headers(): Promise<Record<string, string> | undefined>;
  /** Parses and validates the API response; throws for unexpected shapes. */
  parse(type: SearchType, body: unknown): ParsedResults;
}

export interface ParsedResults {
  empty: boolean;
  /** The single best match for album / station / playlist searches. */
  first(account: ServiceAccount): UriAndMetadata;
  /** Playable tracks for song searches. */
  tracks(account: ServiceAccount): TrackList;
}

export const DIDL_NAMESPACES =
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"';

/** A DIDL-Lite item wrapper shared by every service. */
export function didlItem(
  id: string,
  parentId: string,
  title: string,
  objectClass: string,
  token: string,
): string {
  return `<DIDL-Lite ${DIDL_NAMESPACES}><item id="${id}" parentID="${parentId}" restricted="true"><dc:title>${title}</dc:title><upnp:class>${objectClass}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc></item></DIDL-Lite>`;
}

/** Drops repeated song titles (the APIs return the same song on several albums). */
export function dedupeTracks(tracks: QueueTrack[]): QueueTrack[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.trackName)) {
      return false;
    }

    seen.add(track.trackName);
    return true;
  });
}

/** Lowercases and strips "radio" the way the Sonos apps name station parents. */
export function stationName(title: string): string {
  return title.toLowerCase().replace(' radio', '').replace('radio ', '').replaceAll("'", '&apos;');
}
