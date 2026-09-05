import type { ActionSystem } from './registry.ts';
import { parseInteger } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

/** Pause every playing group now (or in `minutes`), remembering them so `resumeall` can restart them. */
export function registerPauseAllActions(registry: ActionRegistry): void {
  let pausedZones: string[] = [];

  const pauseEverything = async (system: ActionSystem): Promise<void> => {
    const playing = system.zones.filter(
      (zone) => zone.coordinator.state.playbackState === 'PLAYING',
    );
    pausedZones = playing.map((zone) => zone.uuid);
    await Promise.all(playing.map((zone) => zone.coordinator.pause()));
  };

  const resumeEverything = async (system: ActionSystem): Promise<void> => {
    const toResume = pausedZones;
    pausedZones = [];
    await Promise.all(
      toResume
        .map((uuid) => system.getPlayerByUUID(uuid))
        .filter((player) => player !== undefined)
        .map((player) => player.play()),
    );
  };

  const delayed = (values: string[], run: () => Promise<void>): Promise<void> => {
    if (values[0] === undefined) {
      return run();
    }

    const minutes = parseInteger(values[0], 'minutes', { min: 1 });
    setTimeout(() => void run(), minutes * 60_000);
    return Promise.resolve();
  };

  const pauseAll: Action = async ({ system }, values) => {
    await delayed(values, () => pauseEverything(system));
  };
  const resumeAll: Action = async ({ system }, values) => {
    await delayed(values, () => resumeEverything(system));
  };

  registry.register('pauseall', pauseAll, {
    usage: '/pauseall[/{minutes}]',
    description: 'Pause every playing group, now or after a delay in minutes.',
  });
  registry.register('resumeall', resumeAll, {
    usage: '/resumeall[/{minutes}]',
    description: 'Resume the groups that pauseall paused, now or after a delay in minutes.',
  });
}
