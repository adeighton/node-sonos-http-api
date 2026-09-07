import { errorMessage } from '../http/errors.ts';
import type { ActionSystem } from './registry.ts';
import { parseInteger } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

export interface PauseAllResult {
  status: 'success';
  /** Rooms (group coordinators) that were paused and will be resumed by resumeall. */
  paused: string[];
  /** Groups that refused to pause, e.g. a TV input; they are left alone. */
  failed: Array<{ room: string; error: string }>;
}

/** Pause every playing group now (or in `minutes`), remembering them so `resumeall` can restart them. */
export function registerPauseAllActions(registry: ActionRegistry): void {
  let pausedZones: string[] = [];

  /** Best effort: one group refusing to pause must not stop the others from pausing. */
  const pauseEverything = async (system: ActionSystem): Promise<PauseAllResult> => {
    const playing = system.zones.filter(
      (zone) => zone.coordinator.state.playbackState === 'PLAYING',
    );
    const outcomes = await Promise.allSettled(playing.map((zone) => zone.coordinator.pause()));
    const result: PauseAllResult = { status: 'success', paused: [], failed: [] };
    pausedZones = [];
    playing.forEach((zone, index) => {
      const outcome = outcomes[index];
      if (outcome?.status === 'fulfilled') {
        result.paused.push(zone.coordinator.roomName);
        pausedZones.push(zone.uuid);
      } else {
        result.failed.push({
          room: zone.coordinator.roomName,
          error: errorMessage(outcome?.reason),
        });
      }
    });
    return result;
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

  const delayed = <T>(values: string[], run: () => Promise<T>): Promise<T | undefined> => {
    if (values[0] === undefined) {
      return run();
    }

    const minutes = parseInteger(values[0], 'minutes', { min: 1 });
    setTimeout(() => void run(), minutes * 60_000);
    return Promise.resolve(undefined);
  };

  const pauseAll: Action = async ({ system }, values) =>
    delayed(values, () => pauseEverything(system));
  const resumeAll: Action = async ({ system }, values) =>
    delayed(values, () => resumeEverything(system));

  registry.register('pauseall', pauseAll, {
    usage: '/pauseall[/{minutes}]',
    description:
      'Pause every playing group, now or after a delay in minutes; reports groups that refused.',
  });
  registry.register('resumeall', resumeAll, {
    usage: '/resumeall[/{minutes}]',
    description: 'Resume the groups that pauseall paused, now or after a delay in minutes.',
  });
}
