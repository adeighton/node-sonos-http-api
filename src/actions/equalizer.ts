import { parseInteger, parseToggle } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

const nightMode: Action = async ({ player }, values) => {
  const enable = parseToggle(values[0], player.state.equalizer.nightMode ?? false, 'nightmode');
  await player.nightMode(enable);
  return { status: 'success', nightmode: enable };
};

const speechEnhancement: Action = async ({ player }, values) => {
  const enable = parseToggle(
    values[0],
    player.state.equalizer.speechEnhancement ?? false,
    'speechenhancement',
  );
  await player.speechEnhancement(enable);
  return { status: 'success', speechenhancement: enable };
};

const bass: Action = async ({ player }, values) => {
  await player.setBass(parseInteger(values[0], 'bass', { min: -10, max: 10 }));
};

const treble: Action = async ({ player }, values) => {
  await player.setTreble(parseInteger(values[0], 'treble', { min: -10, max: 10 }));
};

export function registerEqualizerActions(registry: ActionRegistry): void {
  registry.register('nightmode', nightMode, {
    usage: '/{room}/nightmode/{on|off|toggle}',
    description: 'Night mode on home theatre players.',
  });
  registry.register('speechenhancement', speechEnhancement, {
    usage: '/{room}/speechenhancement/{on|off|toggle}',
    description: 'Speech enhancement on home theatre players.',
  });
  registry.register('bass', bass, {
    usage: '/{room}/bass/{-10..10}',
    description: 'Set the bass level of the room.',
  });
  registry.register('treble', treble, {
    usage: '/{room}/treble/{-10..10}',
    description: 'Set the treble level of the room.',
  });
}
