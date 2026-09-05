/**
 * Pure state helpers and constant tables for a Sonos player.
 *
 * Ported from the vendored sonos-discovery `types/*` and the helper functions at the top of
 * `models/Player.js`. Nothing in here touches the network or the event loop.
 */

export const PLAY_MODE = Object.freeze({
  NORMAL: 0,
  REPEAT_ALL: 1,
  SHUFFLE_NOREPEAT: 2,
  SHUFFLE: 3,
  REPEAT_ONE: 4,
  SHUFFLE_REPEAT_ONE: 6,
} as const);
export type PlayModeName = keyof typeof PLAY_MODE;

export const REPEAT_MODE = Object.freeze({
  NONE: 'none',
  ALL: 'all',
  ONE: 'one',
} as const);
export type RepeatMode = (typeof REPEAT_MODE)[keyof typeof REPEAT_MODE];

export const URI_TYPE = Object.freeze({
  TRACK: 'track',
  LINE_IN: 'line_in',
  RADIO: 'radio',
} as const);
export type UriType = (typeof URI_TYPE)[keyof typeof URI_TYPE];

export const LIST_TYPE = Object.freeze({
  FAVORITES: 'favorites',
  SAVED_QUEUES: 'saved-queues',
  INPUTS: 'inputs',
} as const);
export type ListType = (typeof LIST_TYPE)[keyof typeof LIST_TYPE];

export const SUB_POLARITY = Object.freeze({
  NONE: 0,
  INVERSE: 1,
} as const);
export type SubPolarity = (typeof SUB_POLARITY)[keyof typeof SUB_POLARITY];

/** Sonos AVTransport states. The union keeps the known values discoverable while accepting new ones. */
export type PlaybackState =
  'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING' | (string & {});

/**
 * Track metadata as parsed from DIDL-Lite. Fields that the metadata does not carry stay
 * `undefined` (and therefore disappear from JSON), matching the behaviour clients rely on.
 */
export interface Track {
  artist?: string;
  title?: string;
  album?: string;
  albumArtUri?: string;
  absoluteAlbumArtUri?: string;
  duration: number;
  uri: string;
  trackUri?: string;
  type: UriType;
  stationName?: string;
}

export interface NextTrack {
  artist?: string;
  title?: string;
  album?: string;
  albumArtUri?: string;
  absoluteAlbumArtUri?: string;
  duration: number;
  uri: string;
}

export interface PlayMode {
  repeat: RepeatMode;
  shuffle: boolean;
  crossfade: boolean;
}

export interface Equalizer {
  bass: number;
  treble: number;
  loudness: boolean;
  speechEnhancement?: boolean;
  nightMode?: boolean;
}

export interface SubState {
  gain?: number;
  crossover?: number;
  polarity?: number;
  enabled?: boolean;
}

/** Mutable per-player state as updated by UPnP notifications. */
export interface InternalState {
  currentTrack: Track;
  nextTrack: NextTrack;
  playMode: PlayMode;
  playlistName: string;
  relTime: number;
  stateTime: number;
  volume: number;
  mute: boolean;
  trackNo: number;
  playbackState: PlaybackState;
  equalizer: Equalizer;
}

/** The frozen, client-facing view returned by `player.state`. */
export interface PlayerSnapshot {
  volume: number;
  mute: boolean;
  equalizer: Equalizer;
  currentTrack: Track;
  nextTrack: NextTrack;
  trackNo: number;
  elapsedTime: number;
  elapsedTimeFormatted: string;
  playbackState: PlaybackState;
  playMode: PlayMode;
  sub?: SubState;
}

export function createEmptyTrack(): Track {
  return {
    artist: '',
    title: '',
    album: '',
    albumArtUri: '',
    duration: 0,
    uri: '',
    trackUri: '',
    type: URI_TYPE.TRACK,
    stationName: '',
  };
}

export function createEmptyNextTrack(): NextTrack {
  return { artist: '', title: '', album: '', albumArtUri: '', duration: 0, uri: '' };
}

/** A fresh, independent copy of the initial player state. */
export function createEmptyState(): InternalState {
  return {
    currentTrack: createEmptyTrack(),
    nextTrack: createEmptyNextTrack(),
    playMode: { repeat: REPEAT_MODE.NONE, shuffle: false, crossfade: false },
    playlistName: '',
    relTime: 0,
    stateTime: 0,
    volume: 0,
    mute: false,
    trackNo: 0,
    playbackState: 'STOPPED',
    equalizer: { bass: 0, treble: 0, loudness: false },
  };
}

/** Parses `h:mm:ss` / `mm:ss` / `ss` into seconds; anything unparseable is 0. */
export function parseTime(formattedTime: string | undefined): number {
  if (formattedTime === undefined) {
    return 0;
  }

  const chunks = formattedTime.split(':').reverse();
  let seconds = 0;
  chunks.forEach((chunk, index) => {
    seconds += Number.parseInt(chunk, 10) * 60 ** index;
  });

  return Number.isNaN(seconds) ? 0 : seconds;
}

/** Formats whole seconds as `hh:mm:ss` (hours grow beyond two digits when needed). */
export function formatTime(totalSeconds: number): string {
  let remaining = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  remaining -= minutes * 60;

  return [hours, minutes, remaining].map((part) => String(part).padStart(2, '0')).join(':');
}

const PLAY_MODE_LOOKUP: ReadonlyMap<number, PlayModeName> = new Map(
  (Object.keys(PLAY_MODE) as PlayModeName[]).map((name) => [PLAY_MODE[name], name]),
);

/** Combines shuffle + repeat flags into the Sonos play-mode name used by SetPlayMode. */
export function getPlayMode(mode: { shuffle: boolean; repeat: RepeatMode }): PlayModeName {
  const shuffleBit = mode.shuffle ? 2 : 0;
  const repeatBits = mode.repeat === REPEAT_MODE.ONE ? 4 : mode.repeat === REPEAT_MODE.ALL ? 1 : 0;
  const name = PLAY_MODE_LOOKUP.get(shuffleBit | repeatBits);
  if (name === undefined) {
    throw new RangeError(`No play mode for shuffle=${String(mode.shuffle)} repeat=${mode.repeat}`);
  }

  return name;
}

const RADIO_PREFIXES = [
  'x-sonosapi-stream:',
  'x-sonosapi-radio:',
  'pndrradio:',
  'x-sonosapi-hls:',
  'x-sonosprog-http:',
  'x-rincon-mp3radio:',
];

const LINE_IN_PREFIXES = ['x-rincon-stream:', 'x-sonos-htastream:'];

export function getUriType(uri: string): UriType {
  if (RADIO_PREFIXES.some((prefix) => uri.startsWith(prefix))) {
    return URI_TYPE.RADIO;
  }

  if (LINE_IN_PREFIXES.some((prefix) => uri.startsWith(prefix))) {
    return URI_TYPE.LINE_IN;
  }

  return URI_TYPE.TRACK;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Returns a frozen copy of `value`, copying and freezing nested plain objects as well.
 * The input is left untouched, so internal mutable state can keep being updated.
 */
export function deepFreeze<T extends object>(value: T): Readonly<T> {
  const copy = { ...value } as Record<string, unknown>;
  for (const [key, child] of Object.entries(copy)) {
    if (isPlainObject(child)) {
      copy[key] = deepFreeze(child);
    }
  }

  return Object.freeze(copy) as Readonly<T>;
}

/**
 * Builds the client-facing snapshot: the player's own volume/mute/equalizer combined with the
 * transport state of its group coordinator, plus the elapsed time extrapolated from the last
 * position report when the coordinator is playing.
 */
export function buildSnapshot(
  player: InternalState,
  coordinator: InternalState,
  sub: SubState | null,
  now: number = Date.now(),
): Readonly<PlayerSnapshot> {
  const drift = coordinator.playbackState === 'PLAYING' ? now - coordinator.stateTime : 0;
  const elapsedTime = coordinator.relTime + Math.floor(drift / 1000);

  const snapshot: PlayerSnapshot = {
    volume: player.volume,
    mute: player.mute,
    equalizer: player.equalizer,
    currentTrack: coordinator.currentTrack,
    nextTrack: coordinator.nextTrack,
    trackNo: coordinator.trackNo,
    elapsedTime,
    elapsedTimeFormatted: formatTime(elapsedTime),
    playbackState: coordinator.playbackState,
    playMode: coordinator.playMode,
  };

  if (sub) {
    snapshot.sub = sub;
  }

  return deepFreeze(snapshot);
}
