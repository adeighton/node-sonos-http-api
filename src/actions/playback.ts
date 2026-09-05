import type { Action, ActionRegistry } from './registry.ts';

const play: Action = async ({ player }) => {
  await player.coordinator.play();
};

const pause: Action = async ({ player }) => {
  await player.coordinator.pause();
};

/** Toggles playback; answers `{ status, paused }` like the original API. */
const playPause: Action = async ({ player }) => {
  const coordinator = player.coordinator;
  if (coordinator.state.playbackState === 'PLAYING') {
    await coordinator.pause();
    return { status: 'success', paused: true };
  }

  await coordinator.play();
  return { status: 'success', paused: false };
};

const next: Action = async ({ player }) => {
  await player.coordinator.nextTrack();
};

const previous: Action = async ({ player }) => {
  await player.coordinator.previousTrack();
};

export function registerPlaybackActions(registry: ActionRegistry): void {
  registry.register('play', play, {
    usage: '/{room}/play',
    description: 'Start playback in the room’s group.',
  });
  registry.register('pause', pause, {
    usage: '/{room}/pause',
    description: 'Pause playback in the room’s group.',
  });
  registry.register('playpause', playPause, {
    usage: '/{room}/playpause',
    description: 'Toggle between playing and paused; answers with the new paused state.',
  });
  registry.register('next', next, {
    usage: '/{room}/next',
    description: 'Skip to the next track.',
  });
  registry.register('previous', previous, {
    usage: '/{room}/previous',
    description: 'Go back to the previous track.',
  });
}
