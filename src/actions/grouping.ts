import { NotFoundError } from '../http/errors.ts';
import type { Player } from '../discovery/player.ts';
import { requireValue } from './parse.ts';
import type { Action, ActionContext, ActionRegistry } from './registry.ts';

function findRoom(context: ActionContext, value: string | undefined): Player {
  const roomName = requireValue(value, 'room name');
  const player = context.system.getPlayer(roomName);
  if (!player) {
    throw new NotFoundError(`Room '${roomName}' not found`);
  }

  return player;
}

/** `/{room}/add/{other}`: the other room joins this room's group. */
const add: Action = async (context, values) => {
  const joining = findRoom(context, values[0]);
  await joining.setAVTransport(`x-rincon:${context.player.coordinator.uuid}`);
};

/** `/{room}/join/{other}`: this room joins the other room's group. */
const join: Action = async (context, values) => {
  const receiving = findRoom(context, values[0]);
  await context.player.setAVTransport(`x-rincon:${receiving.coordinator.uuid}`);
};

const isolate: Action = async ({ player }) => {
  await player.becomeCoordinatorOfStandaloneGroup();
};

export function registerGroupingActions(registry: ActionRegistry): void {
  registry.register('add', add, {
    usage: '/{room}/add/{other room}',
    description: 'Add another room to this room’s group.',
  });
  registry.register('join', join, {
    usage: '/{room}/join/{other room}',
    description: 'Make this room join another room’s group.',
  });
  registry.register(
    'isolate',
    isolate,
    { usage: '/{room}/isolate', description: 'Leave the current group and play alone.' },
    ['ungroup', 'leave'],
  );
}
