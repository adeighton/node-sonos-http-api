/**
 * Every registered action, mapped to the live test file that exercises it against the real
 * system. `actions.test.ts` fails when an action is missing here or names a file that does not
 * exist, so adding an action means deciding how it is verified live.
 *
 * Notes explain the tests that cannot always run: a service account that may not be configured
 * (the test skips itself), hardware the test rooms may lack (the test accepts the UPnP refusal),
 * or an action that would clobber a queue (the test uses a scratch room with an empty queue).
 */
export interface LiveCoverage {
  file: string;
  note?: string;
}

const SERVICE_ACCOUNT = 'skips unless the service is configured on the system';
const HARDWARE = 'accepts a 502 UPnP refusal on players without the feature';
const SCRATCH = 'runs only on a room whose queue is empty';

export const MANIFEST: Record<string, LiveCoverage> = {
  // read-only.test.ts
  zones: { file: 'read-only.test.ts' },
  state: { file: 'read-only.test.ts' },
  favorites: { file: 'read-only.test.ts' },
  favourites: { file: 'read-only.test.ts' },
  playlists: { file: 'read-only.test.ts' },
  queue: { file: 'read-only.test.ts' },
  services: { file: 'read-only.test.ts' },
  debug: { file: 'read-only.test.ts' },
  siriusxm: { file: 'read-only.test.ts', note: 'channel listing; playing is in radio.test.ts' },

  // volume.test.ts
  volume: { file: 'volume.test.ts' },
  groupvolume: { file: 'volume.test.ts' },
  mute: { file: 'volume.test.ts' },
  unmute: { file: 'volume.test.ts' },
  togglemute: { file: 'volume.test.ts' },
  groupmute: { file: 'volume.test.ts' },
  groupunmute: { file: 'volume.test.ts' },
  mutegroup: { file: 'volume.test.ts' },
  unmutegroup: { file: 'volume.test.ts' },
  lockvolumes: { file: 'volume.test.ts' },
  unlockvolumes: { file: 'volume.test.ts' },

  // playback.test.ts
  play: { file: 'playback.test.ts' },
  pause: { file: 'playback.test.ts' },
  playpause: { file: 'playback.test.ts' },
  next: { file: 'playback.test.ts' },
  previous: { file: 'playback.test.ts' },
  seek: { file: 'playback.test.ts' },
  timeseek: { file: 'playback.test.ts' },
  trackseek: { file: 'playback.test.ts' },
  sleep: { file: 'playback.test.ts' },
  pauseall: { file: 'playback.test.ts' },
  resumeall: { file: 'playback.test.ts' },
  favorite: { file: 'playback.test.ts', note: SCRATCH },
  favourite: { file: 'playback.test.ts', note: SCRATCH },
  playlist: { file: 'playback.test.ts', note: SCRATCH },

  // grouping.test.ts
  join: { file: 'grouping.test.ts' },
  leave: { file: 'grouping.test.ts' },
  ungroup: { file: 'grouping.test.ts' },
  isolate: { file: 'grouping.test.ts' },
  add: { file: 'grouping.test.ts' },

  // playmode-eq.test.ts
  repeat: { file: 'playmode-eq.test.ts' },
  shuffle: { file: 'playmode-eq.test.ts' },
  crossfade: { file: 'playmode-eq.test.ts' },
  bass: { file: 'playmode-eq.test.ts' },
  treble: { file: 'playmode-eq.test.ts' },
  nightmode: { file: 'playmode-eq.test.ts', note: HARDWARE },
  speechenhancement: { file: 'playmode-eq.test.ts', note: HARDWARE },
  sub: { file: 'playmode-eq.test.ts', note: HARDWARE },

  // radio.test.ts
  tunein: { file: 'radio.test.ts', note: SCRATCH },
  bbcsounds: { file: 'radio.test.ts', note: SCRATCH },
  linein: { file: 'radio.test.ts', note: HARDWARE },

  // queue.test.ts
  clearqueue: { file: 'queue.test.ts', note: SCRATCH },
  setavtransporturi: { file: 'queue.test.ts', note: SCRATCH },
  reindex: { file: 'queue.test.ts' },

  // presets.test.ts
  preset: { file: 'presets.test.ts' },

  // announce.test.ts
  say: { file: 'announce.test.ts' },
  sayall: { file: 'announce.test.ts' },
  saypreset: { file: 'announce.test.ts' },
  clip: { file: 'announce.test.ts' },
  clipall: { file: 'announce.test.ts' },
  clippreset: { file: 'announce.test.ts' },

  // music-services.test.ts
  musicsearch: { file: 'music-services.test.ts', note: SERVICE_ACCOUNT },
  spotify: { file: 'music-services.test.ts', note: SERVICE_ACCOUNT },
  applemusic: { file: 'music-services.test.ts', note: SERVICE_ACCOUNT },
  amazonmusic: { file: 'music-services.test.ts', note: SERVICE_ACCOUNT },
  napster: { file: 'music-services.test.ts', note: SERVICE_ACCOUNT },
  aldilifemusic: { file: 'music-services.test.ts', note: SERVICE_ACCOUNT },
};
