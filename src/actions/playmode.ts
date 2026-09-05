import { REPEAT_MODE } from '../discovery/player-state.ts';
import type { RepeatMode } from '../discovery/player-state.ts';
import { BadRequestError } from '../http/errors.ts';
import { parseToggle } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

/** `all` / `one` / `none`, plus `on` (all), `off` (none) and `toggle` (all → one → none → all). */
export function parseRepeatMode(value: string | undefined, current: RepeatMode): RepeatMode {
  switch (value) {
    case 'all':
    case 'on':
      return REPEAT_MODE.ALL;
    case 'one':
      return REPEAT_MODE.ONE;
    case 'none':
    case 'off':
      return REPEAT_MODE.NONE;
    case 'toggle':
      return current === REPEAT_MODE.ALL
        ? REPEAT_MODE.ONE
        : current === REPEAT_MODE.ONE
          ? REPEAT_MODE.NONE
          : REPEAT_MODE.ALL;
    default:
      throw new BadRequestError(
        `repeat expects all, one, none, on, off or toggle, got '${value ?? ''}'`,
      );
  }
}

const repeat: Action = async ({ player }, values) => {
  const mode = parseRepeatMode(values[0], player.coordinator.state.playMode.repeat);
  await player.coordinator.repeat(mode);
  return { status: 'success', repeat: mode };
};

const shuffle: Action = async ({ player }, values) => {
  const enable = parseToggle(values[0], player.coordinator.state.playMode.shuffle, 'shuffle');
  await player.coordinator.shuffle(enable);
  return { status: 'success', shuffle: enable };
};

const crossfade: Action = async ({ player }, values) => {
  const enable = parseToggle(values[0], player.coordinator.state.playMode.crossfade, 'crossfade');
  await player.coordinator.crossfade(enable);
  return { status: 'success', crossfade: enable };
};

export function registerPlayModeActions(registry: ActionRegistry): void {
  registry.register('repeat', repeat, {
    usage: '/{room}/repeat/{all|one|none|on|off|toggle}',
    description: 'Set the repeat mode of the group.',
  });
  registry.register('shuffle', shuffle, {
    usage: '/{room}/shuffle/{on|off|toggle}',
    description: 'Set shuffle for the group.',
  });
  registry.register('crossfade', crossfade, {
    usage: '/{room}/crossfade/{on|off|toggle}',
    description: 'Set crossfade for the group.',
  });
}
