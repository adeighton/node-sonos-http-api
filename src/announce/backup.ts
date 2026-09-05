import type { Player, Zone } from '../discovery/player.ts';
import type { Preset } from '../discovery/types.ts';

const RADIO_OR_LINE_IN_PREFIXES = [
  'x-sonosapi-stream:',
  'x-sonosapi-radio:',
  'pndrradio:',
  'x-sonosapi-hls:',
  'x-rincon-stream:',
  'x-sonos-htastream:',
  'x-sonosprog-http:',
  'x-rincon-mp3radio:',
];

/** Streams have no track position to restore. */
export function isRadioOrLineIn(uri: string): boolean {
  return RADIO_OR_LINE_IN_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

/** A player following another player's group (`x-rincon:<uuid>`) cannot seek either. */
export function isGroupLink(uri: string): boolean {
  return uri.startsWith('x-rincon:');
}

/**
 * Whether a queue position is worth restoring: not for streams or group links, and not when the
 * queue was empty (Sonos reports track 0), since seeking there only fails.
 */
export function hasQueuePosition(uri: string, trackNo: number): boolean {
  return !isRadioOrLineIn(uri) && !isGroupLink(uri) && trackNo > 0;
}

/** Everything needed to put a player (or group) back the way it was. */
export interface Backup {
  preset: Preset;
  /**
   * For a coordinator that had members: their uuids, so the player can rejoin whichever of them
   * now coordinates that group (group ids change when the coordinator leaves).
   */
  rejoinMembers?: string[];
}

function zoneOf(system: { zones: Zone[] }, player: Player): Zone | undefined {
  return system.zones.find((zone) => zone.coordinator.uuid === player.coordinator.uuid);
}

function transportBackup(coordinator: Player): Partial<Preset> {
  const state = coordinator.state;
  const preset: Partial<Preset> = {
    state: state.playbackState,
    uri: coordinator.avTransportUri,
    metadata: coordinator.avTransportUriMetadata,
    playMode: { repeat: state.playMode.repeat },
  };
  if (hasQueuePosition(coordinator.avTransportUri, state.trackNo)) {
    preset.trackNo = state.trackNo;
    preset.elapsedTime = state.elapsedTime;
  }

  return preset;
}

/** A backup of one player: its volume, and either its own playback or the group it belonged to. */
export function capturePlayerBackup(system: { zones: Zone[] }, player: Player): Backup {
  const preset: Preset = { players: [{ roomName: player.roomName, volume: player.state.volume }] };

  if (player.coordinator.uuid !== player.uuid) {
    // A member: rejoin its coordinator afterwards.
    preset.uri = `x-rincon:${player.coordinator.uuid}`;
    return { preset };
  }

  const zone = zoneOf(system, player);
  const others = (zone?.members ?? []).filter((member) => member.uuid !== player.uuid);
  if (others.length > 0) {
    return { preset, rejoinMembers: others.map((member) => member.uuid) };
  }

  return { preset: { ...preset, ...transportBackup(player) } };
}

/** A backup of every group, largest first so restoring re-forms the big groups before the small ones. */
export function captureAllBackups(system: { zones: Zone[] }): Backup[] {
  return system.zones
    .map((zone) => {
      const coordinator = zone.coordinator;
      const preset: Preset = {
        players: [
          { roomName: coordinator.roomName, volume: coordinator.state.volume },
          ...zone.members
            .filter((member) => member.uuid !== coordinator.uuid)
            .map((member) => ({ roomName: member.roomName, volume: member.state.volume })),
        ],
        ...transportBackup(coordinator),
      };
      return { preset };
    })
    .sort((a, b) => b.preset.players.length - a.preset.players.length);
}

/** Turns a backup into the preset to apply now, resolving group rejoins against the live topology. */
export function restorePreset(system: { zones: Zone[] }, backup: Backup): Preset {
  if (!backup.rejoinMembers) {
    return backup.preset;
  }

  const zone = system.zones.find((candidate) =>
    candidate.members.some((member) => backup.rejoinMembers?.includes(member.uuid)),
  );
  if (!zone) {
    return backup.preset;
  }

  return { ...backup.preset, uri: `x-rincon:${zone.coordinator.uuid}` };
}
