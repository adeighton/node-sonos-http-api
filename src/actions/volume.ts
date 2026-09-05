import { BadRequestError } from '../http/errors.ts';
import type { Action, ActionRegistry } from './registry.ts';

const VOLUME_PATTERN = /^[+-]?\d+$/;

/** Validates a `/volume/{value}` segment: an absolute 0-100 or a relative +n / -n. */
export function parseVolumeValue(value: string | undefined): string {
  if (value === undefined || !VOLUME_PATTERN.test(value)) {
    throw new BadRequestError(
      `Volume must be a number between 0 and 100 or a relative change like +5 or -5, got '${value ?? ''}'`,
    );
  }

  return value;
}

const volume: Action = async ({ player }, values) => {
  await player.setVolume(parseVolumeValue(values[0]));
};

const groupVolume: Action = async ({ player }, values) => {
  await player.coordinator.setGroupVolume(parseVolumeValue(values[0]));
};

export function registerVolumeActions(registry: ActionRegistry): void {
  registry.register('volume', volume, {
    usage: '/{room}/volume/{0-100|+n|-n}',
    description: 'Set the room volume, absolute or relative.',
  });
  registry.register('groupvolume', groupVolume, {
    usage: '/{room}/groupvolume/{0-100|+n|-n}',
    description: 'Set the volume of the whole group, scaling each member.',
  });
}
