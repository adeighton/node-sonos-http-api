import { mock } from 'node:test';
import type { Mock } from 'node:test';

import type { PresetTarget } from '../discovery/apply-preset.ts';
import type { PlayMode } from '../discovery/player-state.ts';

export interface FakePresetPlayerOptions {
  roomName: string;
  uuid?: string;
  /** uuid of the group coordinator; defaults to the player itself. */
  coordinatorUuid?: string;
  avTransportUri?: string;
}

type Resolving<F extends (...args: never[]) => unknown> = Mock<F>;

/** A PresetTarget whose every command is a resolving mock, for applyPreset / announcement tests. */
export interface FakePresetPlayer extends PresetTarget {
  play: Resolving<() => Promise<void>>;
  pause: Resolving<() => Promise<void>>;
  setVolume: Resolving<(level: number | string) => Promise<void>>;
  mute: Resolving<() => Promise<void>>;
  unMute: Resolving<() => Promise<void>>;
  setAVTransport: Resolving<(uri: string, metadata?: string) => Promise<void>>;
  becomeCoordinatorOfStandaloneGroup: Resolving<() => Promise<void>>;
  replaceWithFavorite: Resolving<(favoriteName: string) => Promise<void>>;
  replaceWithPlaylist: Resolving<(playlistName: string) => Promise<void>>;
  setPlayMode: Resolving<(playMode: Partial<PlayMode>) => Promise<void>>;
  trackSeek: Resolving<(trackNo: number) => Promise<void>>;
  timeSeek: Resolving<(seconds: number) => Promise<void>>;
  sleep: Resolving<(seconds: number) => Promise<void>>;
}

export function fakePresetPlayer(options: FakePresetPlayerOptions): FakePresetPlayer {
  const uuid = options.uuid ?? `RINCON_${options.roomName.toUpperCase().replace(/\W/g, '')}`;
  const resolve = () => Promise.resolve();

  return {
    roomName: options.roomName,
    uuid,
    coordinator: { uuid: options.coordinatorUuid ?? uuid },
    avTransportUri: options.avTransportUri ?? '',
    play: mock.fn(resolve),
    pause: mock.fn(resolve),
    setVolume: mock.fn((_level: number | string) => Promise.resolve()),
    mute: mock.fn(resolve),
    unMute: mock.fn(resolve),
    setAVTransport: mock.fn((_uri: string, _metadata?: string) => Promise.resolve()),
    becomeCoordinatorOfStandaloneGroup: mock.fn(resolve),
    replaceWithFavorite: mock.fn((_favoriteName: string) => Promise.resolve()),
    replaceWithPlaylist: mock.fn((_playlistName: string) => Promise.resolve()),
    setPlayMode: mock.fn((_playMode: Partial<PlayMode>) => Promise.resolve()),
    trackSeek: mock.fn((_trackNo: number) => Promise.resolve()),
    timeSeek: mock.fn((_seconds: number) => Promise.resolve()),
    sleep: mock.fn((_seconds: number) => Promise.resolve()),
  };
}
