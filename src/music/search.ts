import { z } from 'zod';

import type { Player } from '../discovery/player.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import type { ActionSystem } from '../actions/registry.ts';
import { appleMusic } from './apple.ts';
import { createDeezerService } from './deezer.ts';
import type { LibraryIndex } from './library.ts';
import { createSpotifyService } from './spotify.ts';
import type { SpotifyOptions } from './spotify.ts';
import { parseSearchTerms, songSearchKind } from './terms.ts';
import { SEARCH_TYPES } from './types.ts';
import type {
  MusicService,
  SearchType,
  ServiceAccount,
  TrackList,
  UriAndMetadata,
} from './types.ts';

/** A GET returning the response text; the discovery HttpClient satisfies this. */
export type AccountHttp = (options: { url: string }) => Promise<{ body: string }>;

export const MUSIC_SEARCH_TYPES = [...SEARCH_TYPES, 'load'] as const;
export type MusicSearchType = (typeof MUSIC_SEARCH_TYPES)[number];

export interface MusicSearchDeps {
  /** LAN requests to the player (account lookup); the discovery HttpClient fits. */
  http: AccountHttp;
  /** Internet requests (search APIs, country lookup). */
  fetch?: typeof fetch;
  library: LibraryIndex;
  spotify?: SpotifyOptions;
  logger?: Logger;
  timeoutMs?: number;
  random?: () => number;
}

const countrySchema = z.looseObject({ country: z.string() });
const COUNTRY_URL = 'https://ipinfo.io/json';
const DEFAULT_COUNTRY = 'US';

/** Reads the Sonos account (user name and serial) for a service from the player's status page. */
export function parseAccount(
  statusXml: string,
  serviceType: number,
): { accountId: string; accountSN: string } {
  const typeIndex = statusXml.indexOf(String(serviceType));
  if (typeIndex === -1) {
    return { accountId: '', accountSN: '' };
  }

  const idStart = statusXml.indexOf('<UN>', typeIndex) + 4;
  const snStart = statusXml.indexOf('SerialNum="', typeIndex) + 11;
  return {
    accountId: idStart > 3 ? statusXml.slice(idStart, statusXml.indexOf('</UN>', idStart)) : '',
    accountSN: snStart > 10 ? statusXml.slice(snStart, statusXml.indexOf('"', snStart)) : '',
  };
}

/** Whether a song search matched many songs by one artist (play them shuffled) or one song. */
export function looksLikeArtistSearch(tracks: TrackList): boolean {
  if (tracks.count <= 1) {
    return false;
  }

  const artists = new Set(tracks.queueTracks.map((track) => track.artistName.toLowerCase())).size;
  const songs = new Set(tracks.queueTracks.map((track) => track.trackName.toLowerCase())).size;
  return songs / artists > 2;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }

  return copy;
}

/**
 * `/musicsearch/{service}/{type}/{term}`: searches a streaming service or the local library and
 * plays the result on the player's group.
 */
export class MusicSearch {
  readonly #services: Map<string, MusicService>;
  readonly #library: LibraryIndex;
  readonly #http: AccountHttp;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #random: () => number;
  #country: string | undefined;

  constructor(deps: MusicSearchDeps) {
    this.#services = new Map(
      [
        appleMusic,
        createSpotifyService({ ...deps.spotify, fetch: deps.fetch }),
        createDeezerService(),
        createDeezerService({ flac: true, name: 'elite' }),
      ].map((service) => [service.name, service]),
    );
    this.#library = deps.library;
    this.#http = deps.http;
    this.#fetch = deps.fetch ?? fetch;
    this.#logger = deps.logger ?? silentLogger;
    this.#timeoutMs = deps.timeoutMs ?? 10_000;
    this.#random = deps.random ?? Math.random;
  }

  get serviceNames(): string[] {
    return [...this.#services.keys(), 'library'];
  }

  async run(player: Player, system: ActionSystem, values: string[]): Promise<unknown> {
    const [serviceName, type, term] = values;
    if (serviceName === undefined || !this.serviceNames.includes(serviceName)) {
      throw new BadRequestError(
        `Invalid music service; expected one of ${this.serviceNames.join(', ')}`,
      );
    }

    if (type === undefined || !MUSIC_SEARCH_TYPES.includes(type as MusicSearchType)) {
      throw new BadRequestError(
        `Invalid type '${type ?? ''}'; expected one of ${MUSIC_SEARCH_TYPES.join(', ')}`,
      );
    }

    const coordinator = player.coordinator;
    if (serviceName === 'library') {
      return this.#searchLibrary(coordinator, type as MusicSearchType, term);
    }

    if (type === 'load') {
      throw new BadRequestError("'load' only applies to the library service");
    }

    const service = this.#services.get(serviceName);
    if (!service || !service.supports.includes(type as SearchType)) {
      throw new BadRequestError(`${serviceName} cannot search for ${type}`);
    }

    if (term === undefined || term === '') {
      throw new BadRequestError('A search term is required');
    }

    const searchType = type as SearchType;
    const account = await this.#account(coordinator, system, service);
    const terms = parseSearchTerms(term);
    const url = service.searchUrl(searchType, terms, account.country);
    const response = await this.#fetch(url, {
      headers: await service.headers(),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${service.sonosName} search failed with status ${response.status}`);
    }

    const results = service.parse(searchType, await response.json());
    if (results.empty) {
      throw new NotFoundError('No matches were found');
    }

    if (searchType === 'station') {
      const station = results.first(account);
      await coordinator.setAVTransport(station.uri, station.metadata);
      await coordinator.play();
      return;
    }

    if (searchType === 'album' || searchType === 'playlist') {
      await this.#playContainer(coordinator, results.first(account));
      return;
    }

    const tracks = results.tracks(account);
    const kind = songSearchKind(terms);
    tracks.isArtist = kind === 'artist' || (kind === 'song' && looksLikeArtistSearch(tracks));
    await this.#playTracks(coordinator, tracks);
  }

  async #searchLibrary(
    coordinator: Player,
    type: MusicSearchType,
    term: string | undefined,
  ): Promise<unknown> {
    if (type === 'load' || !this.#library.isLoaded) {
      return { status: 'success', message: await this.#library.load(coordinator) };
    }

    if (type !== 'album' && type !== 'song') {
      throw new BadRequestError('The library supports album and song searches');
    }

    if (term === undefined || term === '') {
      throw new BadRequestError('A search term is required');
    }

    const results = this.#library.search(type, term, this.#random);
    if (results.length === 0) {
      throw new NotFoundError('No matches were found');
    }

    const tracks = this.#library.tracks(type, results);
    if (type === 'song' && !tracks.isArtist) {
      tracks.isArtist = looksLikeArtistSearch(tracks);
    }

    await this.#playTracks(coordinator, tracks);
  }

  async #account(
    player: Player,
    system: ActionSystem,
    service: MusicService,
  ): Promise<ServiceAccount> {
    const sid = system.getServiceId(service.sonosName);
    const serviceType = system.getServiceType(service.sonosName);
    const status = await this.#http({ url: `${player.baseUrl}/status/accounts` });
    const { accountId, accountSN } = parseAccount(status.body, serviceType);
    const country = service.needsCountry ? await this.#lookupCountry() : '';
    return { sid, serviceType, accountId, accountSN, country };
  }

  async #lookupCountry(): Promise<string> {
    if (this.#country) {
      return this.#country;
    }

    try {
      const response = await this.#fetch(COUNTRY_URL, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      this.#country = countrySchema.parse(await response.json()).country;
    } catch (error) {
      this.#logger.warn(
        { err: error },
        `could not look up the country, assuming ${DEFAULT_COUNTRY}`,
      );
      this.#country = DEFAULT_COUNTRY;
    }

    return this.#country;
  }

  async #playContainer(coordinator: Player, target: UriAndMetadata): Promise<void> {
    await coordinator.clearQueue();
    await coordinator.setAVTransport(`x-rincon-queue:${coordinator.uuid}#0`, '');
    await coordinator.addURIToQueue(target.uri, target.metadata, true, 1);
    await coordinator.play();
  }

  async #playTracks(coordinator: Player, tracks: TrackList): Promise<void> {
    const queueUri = `x-rincon-queue:${coordinator.uuid}#0`;
    if (tracks.count === 0) {
      throw new NotFoundError('No matches were found');
    }

    if (tracks.isArtist) {
      const ordered = coordinator.state.playMode.shuffle
        ? shuffle(tracks.queueTracks, this.#random)
        : tracks.queueTracks;
      const [first, ...rest] = ordered;
      if (!first) {
        throw new NotFoundError('No matches were found');
      }

      await coordinator.clearQueue();
      await coordinator.setAVTransport(queueUri, '');
      await coordinator.addURIToQueue(first.uri, first.metadata, true, 1);
      await coordinator.play();
      // The rest is enqueued in the background so the request answers as soon as music starts.
      void this.#enqueue(coordinator, rest);
      return;
    }

    const track = tracks.queueTracks[0];
    if (!track) {
      throw new NotFoundError('No matches were found');
    }

    const queue = await coordinator.browse('Q:0', 0, 1);
    const empty = !(queue.totalMatches > 0);
    const nextTrackNo = empty ? 1 : coordinator.state.trackNo + 1;
    await coordinator.addURIToQueue(track.uri, track.metadata, true, nextTrackNo);
    await coordinator.setAVTransport(queueUri, '');
    if (!empty) {
      await coordinator.nextTrack();
    }

    await coordinator.play();
  }

  async #enqueue(coordinator: Player, tracks: TrackList['queueTracks']): Promise<void> {
    for (const [index, track] of tracks.entries()) {
      try {
        await coordinator.addURIToQueue(track.uri, track.metadata, true, index + 2);
      } catch (error) {
        this.#logger.warn({ err: error, track: track.trackName }, 'could not enqueue track');
        return;
      }
    }
  }
}
