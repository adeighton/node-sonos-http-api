import type { VolumeChangeEvent } from '../discovery/player.ts';
import type { Action, ActionRegistry, ActionSystem } from './registry.ts';

/** Freeze every player's volume: any change made elsewhere is reverted until `unlockvolumes`. */
export function registerLockVolumeActions(registry: ActionRegistry): void {
  const locked = new Map<string, number>();
  let watched: ActionSystem | undefined;

  const restore = (change: VolumeChangeEvent): void => {
    const target = locked.get(change.uuid);
    const player = watched?.getPlayerByUUID(change.uuid);
    if (target === undefined || !player || player.state.volume === target) {
      return;
    }

    void player.setVolume(target).catch(() => undefined);
  };

  const lock: Action = ({ system, logger }) => {
    logger.debug('locking volumes');
    locked.clear();
    for (const player of system.players) {
      locked.set(player.uuid, player.state.volume);
    }

    watched?.off('volume-change', restore);
    watched = system;
    system.on('volume-change', restore);
    return Promise.resolve();
  };

  const unlock: Action = ({ system, logger }) => {
    logger.debug('unlocking volumes');
    system.off('volume-change', restore);
    watched = undefined;
    locked.clear();
    return Promise.resolve();
  };

  registry.register('lockvolumes', lock, {
    usage: '/lockvolumes',
    description: 'Freeze the current volume of every player.',
  });
  registry.register('unlockvolumes', unlock, {
    usage: '/unlockvolumes',
    description: 'Stop enforcing the locked volumes.',
  });
}
