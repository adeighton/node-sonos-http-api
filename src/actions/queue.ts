import type { BrowseItem } from '../discovery/types.ts';
import { requireValue } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

function simplify(items: BrowseItem[]) {
  return items.map((item) => ({
    title: item.title,
    artist: item.artist,
    album: item.album,
    albumArtUri: item.albumArtUri,
  }));
}

/** `/{room}/queue[/{limit}[/{offset}]][/detailed]` */
const queue: Action = async ({ player }, values) => {
  const detailed = values.at(-1) === 'detailed';
  const limit = /^\d+$/.test(values[0] ?? '') ? Number.parseInt(values[0] ?? '0', 10) : undefined;
  const offset = /^\d+$/.test(values[1] ?? '') ? Number.parseInt(values[1] ?? '0', 10) : undefined;

  const items = await player.coordinator.getQueue(limit, offset);
  return detailed ? items : simplify(items);
};

const clearQueue: Action = async ({ player }) => {
  await player.coordinator.clearQueue();
};

const setAVTransportUri: Action = async ({ player }, values) => {
  await player.setAVTransport(requireValue(values[0], 'uri'));
};

export function registerQueueActions(registry: ActionRegistry): void {
  registry.register('queue', queue, {
    usage: '/{room}/queue[/{limit}[/{offset}]][/detailed]',
    description: 'The current queue of the group.',
  });
  registry.register('clearqueue', clearQueue, {
    usage: '/{room}/clearqueue',
    description: 'Remove every track from the group’s queue.',
  });
  registry.register('setavtransporturi', setAVTransportUri, {
    usage: '/{room}/setavtransporturi/{uri}',
    description: 'Point the room at any Sonos-compatible uri (advanced).',
  });
}
