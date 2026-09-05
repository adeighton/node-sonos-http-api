import { BadRequestError } from '../http/errors.ts';
import type { Action, ActionRegistry } from './registry.ts';

const sleep: Action = async ({ player }, values) => {
  const value = values[0] ?? '';
  let seconds = 0;
  if (/^\d+$/.test(value)) {
    seconds = Number.parseInt(value, 10);
  } else if (value.toLowerCase() !== 'off') {
    throw new BadRequestError(`sleep expects a number of seconds or 'off', got '${value}'`);
  }

  await player.coordinator.sleep(seconds);
};

export function registerSleepActions(registry: ActionRegistry): void {
  registry.register('sleep', sleep, {
    usage: '/{room}/sleep/{seconds|off}',
    description: 'Set or clear the sleep timer of the group.',
  });
}
