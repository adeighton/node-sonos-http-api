import { BadRequestError } from '../http/errors.ts';
import { parseInteger } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

const sub: Action = async ({ player }, values) => {
  if (!player.hasSub) {
    throw new BadRequestError(`${player.roomName} has no SUB connected`);
  }

  switch (values[0]) {
    case 'on':
      await player.subEnable();
      return;
    case 'off':
      await player.subDisable();
      return;
    case 'gain':
      await player.subGain(parseInteger(values[1], 'gain', { min: -15, max: 15 }));
      return;
    case 'crossover':
      await player.subCrossover(parseInteger(values[1], 'crossover', { min: 40, max: 200 }));
      return;
    case 'polarity':
      await player.subPolarity(parseInteger(values[1], 'polarity', { min: 0, max: 1 }));
      return;
    default:
      throw new BadRequestError('sub expects on, off, gain, crossover or polarity');
  }
};

export function registerSubActions(registry: ActionRegistry): void {
  registry.register('sub', sub, {
    usage: '/{room}/sub/{on|off|gain|crossover|polarity}/{value}',
    description: 'Control the SUB attached to the room.',
  });
}
