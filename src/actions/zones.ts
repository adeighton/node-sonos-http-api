import type { Player, Zone } from '../discovery/player.ts';
import type { Action, ActionRegistry } from './registry.ts';

function simplifyPlayer(player: Player) {
  return {
    uuid: player.uuid,
    state: player.state,
    roomName: player.roomName,
    coordinator: player.coordinator.uuid,
    groupState: player.groupState,
  };
}

/** The `/zones` document: every group with its coordinator and members. */
export function simplifyZones(zones: Zone[]) {
  return zones.map((zone) => ({
    uuid: zone.uuid,
    coordinator: simplifyPlayer(zone.coordinator),
    members: zone.members.map(simplifyPlayer),
  }));
}

const zones: Action = ({ system }) => Promise.resolve(simplifyZones(system.zones));

export function registerZoneActions(registry: ActionRegistry): void {
  registry.register('zones', zones, {
    usage: '/zones',
    description: 'All groups with their coordinator and members.',
  });
}
