import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { ArgumentError } from './errors.ts';
import type { PlayMode } from './player-state.ts';
import { withTransientRetry } from './retry.ts';
import type { Preset } from './types.ts';

/** What applyPreset needs from a player; `Player` satisfies it, and tests use plain fakes. */
export interface PresetTarget {
  roomName: string;
  uuid: string;
  coordinator: { uuid: string };
  avTransportUri: string;
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  setVolume(level: number | string): Promise<unknown>;
  mute(): Promise<unknown>;
  unMute(): Promise<unknown>;
  setAVTransport(uri: string, metadata?: string): Promise<unknown>;
  becomeCoordinatorOfStandaloneGroup(): Promise<unknown>;
  replaceWithFavorite(favoriteName: string): Promise<unknown>;
  replaceWithPlaylist(playlistName: string): Promise<unknown>;
  setPlayMode(playMode: Partial<PlayMode>): Promise<unknown>;
  trackSeek(trackNo: number): Promise<unknown>;
  timeSeek(seconds: number): Promise<unknown>;
  sleep(seconds: number): Promise<unknown>;
}

export interface PresetZone {
  uuid: string;
  coordinator: PresetTarget;
  members: PresetTarget[];
}

export interface PresetSystem {
  zones: PresetZone[];
  getPlayer(roomName: string): PresetTarget | undefined;
}

function resolvePlayers(system: PresetSystem, preset: Preset): PresetTarget[] {
  return preset.players.map((info) => {
    const player = system.getPlayer(info.roomName);
    if (!player) {
      throw new ArgumentError(`Unknown room '${info.roomName}' in preset`);
    }

    return player;
  });
}

/** Joins every player after the first to the first one's group; failures are logged and skipped. */
async function groupWithCoordinator(players: PresetTarget[], logger: Logger): Promise<void> {
  const coordinator = players[0];
  if (!coordinator) {
    return;
  }

  const groupingUri = `x-rincon:${coordinator.uuid}`;
  for (const player of players.slice(1)) {
    if (player.avTransportUri === groupingUri) {
      logger.debug({ room: player.roomName }, 'already grouped with coordinator, skipping');
      continue;
    }

    logger.debug({ room: player.roomName, coordinator: coordinator.roomName }, 'adding to group');
    try {
      await player.setAVTransport(groupingUri);
    } catch (error) {
      logger.warn(
        { err: error, room: player.roomName, coordinator: coordinator.roomName },
        'failed to add player to group',
      );
    }
  }
}

/** Removes members of the coordinator's group that the preset does not mention; failures are logged. */
async function ungroupFromCoordinator(
  system: PresetSystem,
  players: PresetTarget[],
  logger: Logger,
): Promise<void> {
  const coordinator = players[0];
  if (!coordinator) {
    return;
  }

  const zone = system.zones.find((candidate) => candidate.uuid === coordinator.uuid);
  if (!zone) {
    return;
  }

  const wanted = new Set(players.map((player) => player.roomName));
  for (const member of zone.members.filter((candidate) => !wanted.has(candidate.roomName))) {
    logger.debug({ room: member.roomName, coordinator: coordinator.roomName }, 'ungrouping');
    try {
      await member.becomeCoordinatorOfStandaloneGroup();
    } catch (error) {
      logger.warn(
        { err: error, room: member.roomName, coordinator: coordinator.roomName },
        'failed to ungroup player',
      );
    }
  }
}

async function pauseOthers(
  system: PresetSystem,
  players: PresetTarget[],
  logger: Logger,
): Promise<void> {
  const presetUuids = new Set(players.map((player) => player.uuid));
  for (const zone of system.zones.filter((candidate) => !presetUuids.has(candidate.uuid))) {
    logger.debug({ room: zone.coordinator.roomName }, 'pausing');
    try {
      await zone.coordinator.pause();
    } catch (error) {
      logger.debug({ err: error, room: zone.coordinator.roomName }, 'pause failed, ignoring');
    }
  }
}

async function breakOutCoordinator(coordinator: PresetTarget, logger: Logger): Promise<void> {
  try {
    // A player busy regrouping can take longer than the request timeout; one retry covers it.
    await withTransientRetry(() => coordinator.becomeCoordinatorOfStandaloneGroup(), {
      label: 'BecomeCoordinatorOfStandaloneGroup',
      backoffMs: 1000,
      logger,
    });
  } catch (error) {
    // Critical for the preset to work, so this one is not swallowed.
    logger.warn({ err: error, room: coordinator.roomName }, 'failed to break out coordinator');
    throw error;
  }
}

async function applyVolumes(
  players: PresetTarget[],
  preset: Preset,
  logger: Logger,
): Promise<void> {
  for (const [index, info] of preset.players.entries()) {
    const player = players[index];
    if (!player) {
      continue;
    }

    if (info.volume !== undefined) {
      logger.debug({ room: player.roomName, volume: info.volume }, 'setting volume');
      await player.setVolume(info.volume);
    }

    if (info.mute !== undefined) {
      logger.debug({ room: player.roomName, mute: info.mute }, 'setting mute');
      await (info.mute ? player.mute() : player.unMute());
    }
  }
}

/**
 * Applies a preset: groups the listed players under the first one, optionally pauses every other
 * group, selects what to play (favorite, playlist or uri), sets volumes/mutes, play mode, position
 * and sleep timer, then starts playback unless the preset asks for a stopped state.
 */
export async function applyPreset(
  system: PresetSystem,
  preset: Preset,
  logger: Logger = silentLogger,
): Promise<void> {
  const players = resolvePlayers(system, preset);
  const coordinator = players[0];
  if (!coordinator) {
    throw new ArgumentError('Preset has no players');
  }

  logger.debug({ coordinator: coordinator.roomName }, 'applying preset');

  if (coordinator.coordinator.uuid !== coordinator.uuid) {
    logger.debug({ room: coordinator.roomName }, 'breaking out coordinator: it is part of a group');
    await breakOutCoordinator(coordinator, logger);
    await groupWithCoordinator(players, logger);
  } else if (players.length === 1 && coordinator.avTransportUri !== preset.uri) {
    logger.debug({ room: coordinator.roomName }, 'breaking out coordinator: uri differs');
    await breakOutCoordinator(coordinator, logger);
    await groupWithCoordinator(players, logger);
  } else {
    await groupWithCoordinator(players, logger);
    await ungroupFromCoordinator(system, players, logger);
  }

  if (preset.pauseOthers) {
    await pauseOthers(system, players, logger);
  }

  if (preset.favorite !== undefined) {
    await coordinator.replaceWithFavorite(preset.favorite);
  } else if (preset.playlist !== undefined) {
    await coordinator.replaceWithPlaylist(preset.playlist);
  } else if (preset.uri) {
    await coordinator.setAVTransport(preset.uri, preset.metadata);
  }

  await applyVolumes(players, preset, logger);

  if (preset.playMode) {
    try {
      await coordinator.setPlayMode(preset.playMode);
    } catch (error) {
      logger.warn({ err: error, room: coordinator.roomName }, 'setPlayMode failed');
    }
  }

  if (preset.trackNo) {
    try {
      await coordinator.trackSeek(preset.trackNo);
    } catch (error) {
      logger.warn({ err: error, room: coordinator.roomName }, 'trackSeek failed');
    }
  }

  if (preset.elapsedTime) {
    try {
      await coordinator.timeSeek(preset.elapsedTime);
    } catch (error) {
      logger.warn({ err: error, room: coordinator.roomName }, 'timeSeek failed');
    }
  }

  if (preset.sleep) {
    await coordinator.sleep(preset.sleep);
  }

  if (!preset.state || preset.state.toLowerCase() === 'playing') {
    await coordinator.play();
  }
}
