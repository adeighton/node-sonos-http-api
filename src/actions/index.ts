import { createHttpClient } from '../discovery/http.ts';
import type { HttpClient } from '../discovery/http.ts';
import type { Logger } from '../logger.ts';
import { LibraryIndex } from '../music/library.ts';
import { MusicSearch } from '../music/search.ts';
import type { SpotifyOptions } from '../music/spotify.ts';
import { registerBbcSoundsActions } from './bbc-sounds.ts';
import { registerClipActions } from './clip.ts';
import { registerEqualizerActions } from './equalizer.ts';
import { registerFavoriteActions } from './favorites.ts';
import { registerGroupingActions } from './grouping.ts';
import { registerLineInActions } from './linein.ts';
import { registerLockVolumeActions } from './lockvolumes.ts';
import { registerMusicSearchActions } from './music-search.ts';
import { registerMuteActions } from './mute.ts';
import { registerPauseAllActions } from './pauseall.ts';
import { registerPlaybackActions } from './playback.ts';
import { registerPlaylistActions } from './playlists.ts';
import { registerPlayModeActions } from './playmode.ts';
import { registerPresetActions } from './presets.ts';
import { registerQueueActions } from './queue.ts';
import { ActionRegistry } from './registry.ts';
import { registerSayActions } from './say.ts';
import { registerSeekActions } from './seek.ts';
import { registerSiriusXmActions } from './siriusxm.ts';
import { registerSleepActions } from './sleep.ts';
import { registerStateActions } from './state.ts';
import { registerStreamingActions } from './streaming.ts';
import { registerSubActions } from './sub.ts';
import { registerSystemActions } from './system.ts';
import { registerTuneInActions } from './tunein.ts';
import { registerVolumeActions } from './volume.ts';
import { registerZoneActions } from './zones.ts';

export interface ActionRegistryDeps {
  /** Where the crawled music library cache lives. */
  cacheDir: string;
  spotify?: SpotifyOptions;
  randomQueueLimit?: number;
  logger?: Logger;
  http?: HttpClient;
  fetch?: typeof fetch;
}

/** Builds the registry with every action the API offers, in one explicit place. */
export function createActionRegistry(deps: ActionRegistryDeps): ActionRegistry {
  const registry = new ActionRegistry();
  const library = new LibraryIndex({
    cacheDir: deps.cacheDir,
    randomQueueLimit: deps.randomQueueLimit,
    logger: deps.logger,
  });
  void library.readCache();
  const search = new MusicSearch({
    http: deps.http ?? createHttpClient(),
    fetch: deps.fetch,
    library,
    spotify: deps.spotify,
    logger: deps.logger,
  });

  registerPlaybackActions(registry);
  registerVolumeActions(registry);
  registerMuteActions(registry);
  registerSeekActions(registry);
  registerSleepActions(registry);
  registerGroupingActions(registry);
  registerPlayModeActions(registry);
  registerEqualizerActions(registry);
  registerSubActions(registry);
  registerLineInActions(registry);
  registerTuneInActions(registry);
  registerBbcSoundsActions(registry);
  registerSiriusXmActions(registry);
  registerFavoriteActions(registry);
  registerPlaylistActions(registry);
  registerQueueActions(registry);
  registerStateActions(registry);
  registerZoneActions(registry);
  registerPresetActions(registry);
  registerSayActions(registry);
  registerClipActions(registry);
  registerMusicSearchActions(registry, search);
  registerStreamingActions(registry);
  registerSystemActions(registry);
  registerPauseAllActions(registry);
  registerLockVolumeActions(registry);
  return registry;
}
