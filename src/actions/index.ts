import { registerBbcSoundsActions } from './bbc-sounds.ts';
import { registerEqualizerActions } from './equalizer.ts';
import { registerFavoriteActions } from './favorites.ts';
import { registerGroupingActions } from './grouping.ts';
import { registerLineInActions } from './linein.ts';
import { registerLockVolumeActions } from './lockvolumes.ts';
import { registerMuteActions } from './mute.ts';
import { registerPauseAllActions } from './pauseall.ts';
import { registerPlaybackActions } from './playback.ts';
import { registerPlaylistActions } from './playlists.ts';
import { registerPlayModeActions } from './playmode.ts';
import { registerPresetActions } from './presets.ts';
import { registerQueueActions } from './queue.ts';
import { ActionRegistry } from './registry.ts';
import { registerSeekActions } from './seek.ts';
import { registerSleepActions } from './sleep.ts';
import { registerStateActions } from './state.ts';
import { registerSubActions } from './sub.ts';
import { registerSystemActions } from './system.ts';
import { registerTuneInActions } from './tunein.ts';
import { registerVolumeActions } from './volume.ts';
import { registerZoneActions } from './zones.ts';

/** Builds the registry with every action the API offers, in one explicit place. */
export function createActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
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
  registerFavoriteActions(registry);
  registerPlaylistActions(registry);
  registerQueueActions(registry);
  registerStateActions(registry);
  registerZoneActions(registry);
  registerPresetActions(registry);
  registerSystemActions(registry);
  registerPauseAllActions(registry);
  registerLockVolumeActions(registry);
  return registry;
}
