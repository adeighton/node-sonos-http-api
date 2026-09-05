import { requireValue } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

const playlists: Action = async ({ system }, values) => {
  const list = await system.getPlaylists();
  return values[0] === 'detailed' ? list : list.map((item) => item.title);
};

const playlist: Action = async ({ player }, values) => {
  await player.coordinator.replaceWithPlaylist(requireValue(values[0], 'playlist name'));
  await player.coordinator.play();
};

export function registerPlaylistActions(registry: ActionRegistry): void {
  registry.register('playlists', playlists, {
    usage: '/playlists[/detailed]',
    description: 'List the Sonos playlists.',
  });
  registry.register('playlist', playlist, {
    usage: '/{room}/playlist/{name}',
    description: 'Replace the queue with a Sonos playlist and play it.',
  });
}
