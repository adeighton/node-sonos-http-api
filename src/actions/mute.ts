import type { Action, ActionRegistry } from './registry.ts';

const mute: Action = async ({ player }) => {
  await player.mute();
};

const unmute: Action = async ({ player }) => {
  await player.unMute();
};

const groupMute: Action = async ({ player }) => {
  await player.coordinator.muteGroup();
};

const groupUnmute: Action = async ({ player }) => {
  await player.coordinator.unMuteGroup();
};

const toggleMute: Action = async ({ player }) => {
  if (player.state.mute) {
    await player.unMute();
    return { status: 'success', muted: false };
  }

  await player.mute();
  return { status: 'success', muted: true };
};

export function registerMuteActions(registry: ActionRegistry): void {
  registry.register('mute', mute, { usage: '/{room}/mute', description: 'Mute the room.' });
  registry.register('unmute', unmute, { usage: '/{room}/unmute', description: 'Unmute the room.' });
  registry.register('togglemute', toggleMute, {
    usage: '/{room}/togglemute',
    description: 'Toggle mute; answers with the new muted state.',
  });
  registry.register(
    'groupmute',
    groupMute,
    { usage: '/{room}/groupmute', description: 'Mute the whole group.' },
    ['mutegroup'],
  );
  registry.register(
    'groupunmute',
    groupUnmute,
    { usage: '/{room}/groupunmute', description: 'Unmute the whole group.' },
    ['unmutegroup'],
  );
}
