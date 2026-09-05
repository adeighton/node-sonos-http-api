import type { MusicSearch } from '../music/search.ts';
import type { Action, ActionRegistry } from './registry.ts';

export function registerMusicSearchActions(registry: ActionRegistry, search: MusicSearch): void {
  const musicSearch: Action = ({ player, system }, values) => search.run(player, system, values);

  registry.register('musicsearch', musicSearch, {
    usage:
      '/{room}/musicsearch/{apple|spotify|deezer|elite|library}/{album|song|station|playlist|load}/{term}',
    description:
      'Search a music service (or the local library) and play the result; terms may use artist:, album: and track: specifiers.',
  });
}
