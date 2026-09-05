import { requireValue } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

const favorites: Action = async ({ system }, values) => {
  const list = await system.getFavorites();
  return values[0] === 'detailed' ? list : list.map((item) => item.title);
};

const favorite: Action = async ({ player }, values) => {
  await player.coordinator.replaceWithFavorite(requireValue(values[0], 'favorite name'));
  await player.coordinator.play();
};

export function registerFavoriteActions(registry: ActionRegistry): void {
  registry.register(
    'favorites',
    favorites,
    { usage: '/favorites[/detailed]', description: 'List the Sonos favorites.' },
    ['favourites'],
  );
  registry.register(
    'favorite',
    favorite,
    { usage: '/{room}/favorite/{name}', description: 'Play a Sonos favorite in the group.' },
    ['favourite'],
  );
}
