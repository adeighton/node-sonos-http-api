import type { Action, ActionRegistry } from './registry.ts';

const state: Action = ({ player }) => Promise.resolve(player.state);

export function registerStateActions(registry: ActionRegistry): void {
  registry.register('state', state, {
    usage: '/{room}/state',
    description: 'The current track, playback state, volume and play mode of the room.',
  });
}
