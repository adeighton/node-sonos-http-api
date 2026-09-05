import { EventEmitter } from 'node:events';
import { mock } from 'node:test';

import type { ActionSystem } from '../actions/registry.ts';
import { UnknownServiceError } from '../discovery/errors.ts';
import type { Player, PlayerSystem, SonosSystemEvents, Zone } from '../discovery/player.ts';
import type { AvailableService, BrowseItem, Preset } from '../discovery/types.ts';

export interface RecordedSystemEvent {
  event: keyof SonosSystemEvents;
  args: unknown[];
}

/**
 * A stand-in for SonosSystem: holds zones and players, records the events emitted on it, serves
 * canned favorites / playlists / services and records applied presets.
 */
export class FakeSystem
  extends EventEmitter<SonosSystemEvents>
  implements PlayerSystem, ActionSystem
{
  zones: Zone[] = [];
  players: Player[] = [];
  localEndpoint = '127.0.0.1';
  availableServices: Record<string, AvailableService> = {};
  favorites: BrowseItem[] = [];
  playlists: BrowseItem[] = [];
  readonly appliedPresets: Preset[] = [];
  readonly getFavorites = mock.fn((): Promise<BrowseItem[]> => Promise.resolve(this.favorites));
  readonly getPlaylists = mock.fn((): Promise<BrowseItem[]> => Promise.resolve(this.playlists));
  readonly refreshShareIndex = mock.fn((): Promise<void> => Promise.resolve());
  readonly applyPreset = mock.fn((preset: Preset): Promise<void> => {
    this.appliedPresets.push(preset);
    return Promise.resolve();
  });
  /** Every event emitted on the system, in order. */
  readonly emitted: RecordedSystemEvent[] = [];
  #anyPlayerIndex = 0;

  constructor() {
    super();
    this.on('topology-change', (zones) => this.#record('topology-change', [zones]));
    this.on('transport-state', (player) => this.#record('transport-state', [player]));
    this.on('volume-change', (change) => this.#record('volume-change', [change]));
    this.on('mute-change', (change) => this.#record('mute-change', [change]));
    this.on('group-mute', (change) => this.#record('group-mute', [change]));
    this.on('group-volume', (change) => this.#record('group-volume', [change]));
    this.on('queue-change', (player) => this.#record('queue-change', [player]));
    this.on('list-change', (type) => this.#record('list-change', [type]));
    this.on('initialized', () => this.#record('initialized', []));
  }

  /** The recorded events of one kind. */
  eventsOf(event: keyof SonosSystemEvents): RecordedSystemEvent[] {
    return this.emitted.filter((recorded) => recorded.event === event);
  }

  getPlayer(roomName: string): Player | undefined {
    const wanted = roomName.toLowerCase();
    return this.players.find((player) => player.roomName.toLowerCase() === wanted);
  }

  getPlayerByUUID(uuid: string): Player | undefined {
    return this.players.find((player) => player.uuid === uuid);
  }

  getAnyPlayer(): Player | undefined {
    if (this.players.length === 0) {
      return undefined;
    }

    return this.players[this.#anyPlayerIndex++ % this.players.length];
  }

  getServiceId(serviceName: string): number {
    return this.#requireService(serviceName).id;
  }

  getServiceType(serviceName: string): number {
    return this.#requireService(serviceName).type;
  }

  /** Registers `player` as the coordinator of its own single-member zone. */
  addStandalone(player: Player): Zone {
    const zone: Zone = {
      coordinator: player,
      members: [player],
      uuid: player.uuid,
      id: `${player.uuid}:1`,
    };
    player.coordinator = player;
    this.zones.push(zone);
    this.players.push(player);
    return zone;
  }

  #requireService(serviceName: string): AvailableService {
    const service = this.availableServices[serviceName];
    if (!service) {
      throw new UnknownServiceError(serviceName);
    }

    return service;
  }

  #record(event: keyof SonosSystemEvents, args: unknown[]): void {
    this.emitted.push({ event, args });
  }
}
