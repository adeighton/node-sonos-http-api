import { parseInteger } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

const timeSeek: Action = async ({ player }, values) => {
  await player.coordinator.timeSeek(parseInteger(values[0], 'seconds', { min: 0 }));
};

const trackSeek: Action = async ({ player }, values) => {
  await player.coordinator.trackSeek(parseInteger(values[0], 'track number', { min: 1 }));
};

export function registerSeekActions(registry: ActionRegistry): void {
  registry.register(
    'timeseek',
    timeSeek,
    { usage: '/{room}/timeseek/{seconds}', description: 'Seek within the current track.' },
    ['seek'],
  );
  registry.register('trackseek', trackSeek, {
    usage: '/{room}/trackseek/{track number}',
    description: 'Jump to a track in the queue (1-based).',
  });
}
