import { NotFoundError } from '../http/errors.ts';
import type { Action, ActionRegistry } from './registry.ts';

/** `/{room}/linein[/{source room}]`: play the line-in of this (or another) room in this room's group. */
const lineIn: Action = async ({ player, system }, values) => {
  const sourceName = values[0];
  const source = sourceName ? system.getPlayer(sourceName) : player;
  if (!source) {
    throw new NotFoundError(`Room '${sourceName ?? ''}' not found`);
  }

  await player.coordinator.setAVTransport(`x-rincon-stream:${source.uuid}`);
  await player.coordinator.play();
};

export function registerLineInActions(registry: ActionRegistry): void {
  registry.register('linein', lineIn, {
    usage: '/{room}/linein[/{source room}]',
    description: 'Play the line-in input of this room, or of another room, in this group.',
  });
}
