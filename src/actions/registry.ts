import type { EventEmitter } from 'node:events';

import type { Settings } from '../config/schema.ts';
import type { Player, SonosSystemEvents, Zone } from '../discovery/player.ts';
import type { AvailableService, BrowseItem, Preset } from '../discovery/types.ts';
import type { Announcement, AnnounceTarget } from '../announce/announce.ts';
import type { Logger } from '../logger.ts';
import type { PresetStore } from '../presets/store.ts';
import type { ClipLibrary } from '../tts/clips.ts';
import type { TtsService } from '../tts/index.ts';

/** Plays a clip on a target and restores the previous state afterwards (see announce/announce.ts). */
export interface AnnouncerLike {
  announce(target: AnnounceTarget, announcement: Announcement): Promise<void>;
}

/** What actions may use of the Sonos system (SonosSystem satisfies it; tests use a fake). */
export interface ActionSystem extends Pick<EventEmitter<SonosSystemEvents>, 'on' | 'once' | 'off'> {
  zones: Zone[];
  players: Player[];
  localEndpoint: string;
  availableServices: Record<string, AvailableService>;
  getPlayer(roomName: string): Player | undefined;
  getPlayerByUUID(uuid: string): Player | undefined;
  getAnyPlayer(): Player | undefined;
  applyPreset(preset: Preset): Promise<void>;
  getFavorites(): Promise<BrowseItem[]>;
  getPlaylists(): Promise<BrowseItem[]>;
  refreshShareIndex(): Promise<void>;
  getServiceId(serviceName: string): number;
  getServiceType(serviceName: string): number;
}

/** Everything an action receives besides its URL values. */
export interface ActionContext {
  /** The room named in the URL, or any player when the URL started with the action. */
  player: Player;
  system: ActionSystem;
  settings: Settings;
  presets: PresetStore;
  tts: TtsService;
  clips: ClipLibrary;
  announcer: AnnouncerLike;
  logger: Logger;
  /** Where players can fetch clips from this server, e.g. `http://192.168.1.10:5005`. */
  publicBaseUrl: string;
  /** The package version, for the debug endpoint. */
  version: string;
}

/** An action handler. Values are the already-decoded URL segments after the action name. */
export type Action = (context: ActionContext, values: string[]) => Promise<unknown>;

export interface ActionMeta {
  /** Shown on the index page, e.g. `/{room}/volume/{0-100|+n|-n}`. */
  usage: string;
  description: string;
}

export interface RegisteredAction {
  name: string;
  aliases: string[];
  meta: ActionMeta;
  action: Action;
}

/** The explicit table of actions; names are case-insensitive. */
export class ActionRegistry {
  readonly #registered = new Map<string, RegisteredAction>();
  readonly #byName = new Map<string, RegisteredAction>();

  register(name: string, action: Action, meta: ActionMeta, aliases: string[] = []): void {
    const normalized = name.toLowerCase();
    const entry: RegisteredAction = {
      name: normalized,
      aliases: aliases.map((alias) => alias.toLowerCase()),
      meta,
      action,
    };

    for (const candidate of [normalized, ...entry.aliases]) {
      if (this.#byName.has(candidate)) {
        throw new Error(`Action '${candidate}' is already registered`);
      }
    }

    this.#registered.set(normalized, entry);
    for (const candidate of [normalized, ...entry.aliases]) {
      this.#byName.set(candidate, entry);
    }
  }

  get(name: string): Action | undefined {
    return this.#byName.get(name.toLowerCase())?.action;
  }

  has(name: string): boolean {
    return this.#byName.has(name.toLowerCase());
  }

  /** Primary entries, sorted by name. */
  list(): RegisteredAction[] {
    return [...this.#registered.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every name that resolves to an action, aliases included, sorted. */
  names(): string[] {
    return [...this.#byName.keys()].sort((a, b) => a.localeCompare(b));
  }
}
