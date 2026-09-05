import { EventEmitter } from 'node:events';
import { mock } from 'node:test';

import type { Player, PlayerSystem, SonosSystemEvents, Zone } from '../discovery/player.ts';
import type { BrowseItem } from '../discovery/types.ts';

export interface RecordedSystemEvent {
  event: keyof SonosSystemEvents;
  args: unknown[];
}

/**
 * A stand-in for SonosSystem from a Player's point of view: holds zones, records the events
 * players re-emit, and serves canned favorites / playlists.
 */
export class FakeSystem extends EventEmitter<SonosSystemEvents> implements PlayerSystem {
  zones: Zone[] = [];
  players: Player[] = [];
  favorites: BrowseItem[] = [];
  playlists: BrowseItem[] = [];
  readonly getFavorites = mock.fn((): Promise<BrowseItem[]> => Promise.resolve(this.favorites));
  readonly getPlaylists = mock.fn((): Promise<BrowseItem[]> => Promise.resolve(this.playlists));
  /** Every event emitted on the system, in order. */
  readonly emitted: RecordedSystemEvent[] = [];

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

  #record(event: keyof SonosSystemEvents, args: unknown[]): void {
    this.emitted.push({ event, args });
  }
}
