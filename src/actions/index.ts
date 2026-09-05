import { registerPlaybackActions } from './playback.ts';
import { registerPresetActions } from './presets.ts';
import { ActionRegistry } from './registry.ts';
import { registerStateActions } from './state.ts';
import { registerVolumeActions } from './volume.ts';
import { registerZoneActions } from './zones.ts';

/** Builds the registry with every action the API offers, in one explicit place. */
export function createActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registerPlaybackActions(registry);
  registerVolumeActions(registry);
  registerStateActions(registry);
  registerZoneActions(registry);
  registerPresetActions(registry);
  return registry;
}
