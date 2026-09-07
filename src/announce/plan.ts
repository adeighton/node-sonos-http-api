import type { Player, Zone } from '../discovery/player.ts';
import type { Preset, PresetPlayer } from '../discovery/types.ts';
import { BadRequestError, ServiceUnavailableError } from '../http/errors.ts';
import type { AnnounceSystem, AnnounceTarget, AnnouncementSpec } from './types.ts';

export interface AnnouncementPlan {
  /** The player whose transport plays the clip and whose state signals its end. */
  coordinator: Player;
  /**
   * Forms the announcement group: rooms, volumes and pausing, but no transport, so it can be
   * applied before the clip exists. The clip is set on the coordinator afterwards.
   */
  preset: Preset;
  /** True once the topology shows exactly the preset's rooms grouped under the coordinator. */
  expectedTopology: (zones: Zone[]) => boolean;
}

function findPlayer(system: AnnounceSystem, roomName: string): Player | undefined {
  const wanted = roomName.toLowerCase();
  return system.players.find((player) => player.roomName.toLowerCase() === wanted);
}

function groupedExactly(coordinator: Player, players: Player[]): (zones: Zone[]) => boolean {
  const wanted = new Set(players.map((player) => player.uuid));
  return (zones) =>
    zones.some(
      (zone) =>
        zone.coordinator.uuid === coordinator.uuid &&
        zone.members.length === wanted.size &&
        zone.members.every((member) => wanted.has(member.uuid)),
    );
}

function withVolume(players: PresetPlayer[], volume: number | undefined): PresetPlayer[] {
  return volume === undefined ? players : players.map((player) => ({ ...player, volume }));
}

/** A short label for logs and the history: `all`, `preset:doorbell`, `room:Kitchen`, `rooms:A,B`. */
export function describeTarget(target: AnnounceTarget): string {
  switch (target.kind) {
    case 'player':
      return `room:${target.player.roomName}`;
    case 'all':
      return 'all';
    case 'rooms':
      return `rooms:${target.rooms.map((room) => room.player.roomName).join(',')}`;
    case 'preset':
      return `preset:${target.name ?? target.preset.players.map((p) => p.roomName).join(',')}`;
  }
}

/** Decides which players take part, who leads them and what the group should look like. */
export function planAnnouncement(
  system: AnnounceSystem,
  spec: Pick<AnnouncementSpec, 'target' | 'volume' | 'pauseOthers'>,
): AnnouncementPlan {
  const { target } = spec;
  switch (target.kind) {
    case 'player':
      return {
        coordinator: target.player,
        preset: {
          players: [{ roomName: target.player.roomName, volume: spec.volume }],
          playMode: { repeat: 'none' },
          pauseOthers: spec.pauseOthers ?? false,
          state: 'STOPPED',
        },
        expectedTopology: groupedExactly(target.player, [target.player]),
      };
    case 'all': {
      const biggest = [...system.zones].sort((a, b) => b.members.length - a.members.length)[0];
      if (!biggest) {
        throw new ServiceUnavailableError('No Sonos players are available for the announcement');
      }

      const coordinator = biggest.coordinator;
      const others = system.players.filter((player) => player.uuid !== coordinator.uuid);
      const players = [coordinator, ...others];
      return {
        coordinator,
        preset: {
          players: players.map((player) => ({ roomName: player.roomName, volume: spec.volume })),
          playMode: { repeat: 'none' },
          pauseOthers: spec.pauseOthers ?? true,
          state: 'STOPPED',
        },
        expectedTopology: groupedExactly(coordinator, players),
      };
    }
    case 'rooms': {
      const coordinator = target.rooms[0]?.player;
      if (!coordinator) {
        throw new BadRequestError('At least one room is required');
      }

      return {
        coordinator,
        preset: {
          players: target.rooms.map(({ player, volume }) => ({
            roomName: player.roomName,
            volume: volume ?? spec.volume,
          })),
          playMode: { repeat: 'none' },
          pauseOthers: spec.pauseOthers ?? false,
          state: 'STOPPED',
        },
        expectedTopology: groupedExactly(
          coordinator,
          target.rooms.map((room) => room.player),
        ),
      };
    }
    case 'preset': {
      const { preset } = target;
      const players = preset.players.map((info) => findPlayer(system, info.roomName));
      const coordinator = players[0];
      const missing = preset.players.find((_, index) => players[index] === undefined);
      if (!coordinator || missing) {
        throw new BadRequestError(`Preset room '${missing?.roomName ?? ''}' is not a known player`);
      }

      return {
        coordinator,
        preset: {
          players: withVolume(preset.players, spec.volume),
          playMode: preset.playMode ?? { repeat: 'none' },
          pauseOthers: spec.pauseOthers ?? preset.pauseOthers ?? true,
          state: 'STOPPED',
        },
        expectedTopology: groupedExactly(
          coordinator,
          players.filter((player): player is Player => player !== undefined),
        ),
      };
    }
  }
}
