import type { Player, Zone } from '../discovery/player.ts';
import type { Preset } from '../discovery/types.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { captureAllBackups, capturePlayerBackup, restorePreset } from './backup.ts';
import type { Backup } from './backup.ts';

/** The subset of SonosSystem the announcer needs. */
export interface AnnounceSystem {
  zones: Zone[];
  players: Player[];
  applyPreset(preset: Preset): Promise<void>;
  on(event: 'topology-change', listener: (zones: Zone[]) => void): unknown;
  off(event: 'topology-change', listener: (zones: Zone[]) => void): unknown;
}

export type AnnounceTarget =
  { kind: 'player'; player: Player } | { kind: 'all' } | { kind: 'preset'; preset: Preset };

export interface Announcement {
  /** Absolute url the players fetch, e.g. `http://192.168.1.10:5005/tts/x.mp3`. */
  uri: string;
  /** Length of the clip; playback is given this long plus a margin before restoring. */
  durationMs: number;
  /** Volume for every player taking part (presets bring their own volumes). */
  volume?: number | undefined;
}

export interface AnnouncerOptions {
  system: AnnounceSystem;
  logger?: Logger;
  /** How long to wait for the players to regroup before playing. Default 10 s. */
  topologyTimeoutMs?: number;
}

const RESTORE_MARGIN_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Plan {
  preset: Preset;
  /** The player whose transport state signals the end of the clip. */
  coordinator: Player;
  /** When set, playback waits until the topology matches (players regrouped). */
  expectedTopology?: (zones: Zone[]) => boolean;
}

/**
 * Plays clips (doorbells, spoken announcements) on one player, on all of them, or on a preset's
 * players, then puts everything back: volumes, grouping, what was playing and where.
 * Announcements run one at a time so their backups never capture each other's clips.
 */
export class Announcer {
  readonly #system: AnnounceSystem;
  readonly #logger: Logger;
  readonly #topologyTimeoutMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: AnnouncerOptions) {
    this.#system = options.system;
    this.#logger = options.logger ?? silentLogger;
    this.#topologyTimeoutMs = options.topologyTimeoutMs ?? 10_000;
  }

  announce(target: AnnounceTarget, announcement: Announcement): Promise<void> {
    const run = this.#queue.then(() => this.#run(target, announcement));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #run(target: AnnounceTarget, announcement: Announcement): Promise<void> {
    const backups = this.#capture(target);
    const plan = this.#plan(target, announcement);
    this.#logger.debug({ kind: target.kind, uri: announcement.uri }, 'starting announcement');

    try {
      if (target.kind === 'preset') {
        await plan.coordinator.pause().catch(() => undefined);
      }

      await this.#applyWithRetry(plan.preset, target.kind === 'preset');

      if (plan.expectedTopology && !plan.expectedTopology(this.#system.zones)) {
        await this.#waitForTopology(plan.expectedTopology);
      }

      if (target.kind !== 'player') {
        await plan.coordinator.play();
      }

      await this.#waitForEnd(plan.coordinator, announcement.durationMs);
    } finally {
      await this.#restore(backups);
    }
  }

  #capture(target: AnnounceTarget): Backup[] {
    return target.kind === 'player'
      ? [capturePlayerBackup(this.#system, target.player)]
      : captureAllBackups(this.#system);
  }

  #plan(target: AnnounceTarget, announcement: Announcement): Plan {
    switch (target.kind) {
      case 'player':
        return {
          coordinator: target.player,
          preset: {
            players: [{ roomName: target.player.roomName, volume: announcement.volume }],
            playMode: { repeat: 'none' },
            uri: announcement.uri,
          },
        };
      case 'all': {
        const biggest = [...this.#system.zones].sort(
          (a, b) => b.members.length - a.members.length,
        )[0];
        if (!biggest) {
          throw new Error('No Sonos players are available for the announcement');
        }

        const coordinator = biggest.coordinator;
        const others = this.#system.players.filter((player) => player.uuid !== coordinator.uuid);
        return {
          coordinator,
          preset: {
            uri: announcement.uri,
            players: [coordinator, ...others].map((player) => ({
              roomName: player.roomName,
              volume: announcement.volume,
            })),
            playMode: { repeat: 'none' },
            pauseOthers: true,
            state: 'STOPPED',
          },
          expectedTopology: (zones) => zones.length === 1,
        };
      }
      case 'preset': {
        const first = target.preset.players[0];
        const coordinator = first
          ? this.#system.players.find(
              (player) => player.roomName.toLowerCase() === first.roomName.toLowerCase(),
            )
          : undefined;
        if (!first || !coordinator) {
          throw new Error(`Preset room '${first?.roomName ?? ''}' is not a known player`);
        }

        return {
          coordinator,
          preset: {
            uri: announcement.uri,
            players: target.preset.players,
            playMode: target.preset.playMode ?? { repeat: 'none' },
            pauseOthers: true,
            state: 'STOPPED',
          },
          expectedTopology: (zones) =>
            zones.some(
              (zone) =>
                zone.members.length === target.preset.players.length &&
                zone.coordinator.roomName.toLowerCase() === first.roomName.toLowerCase(),
            ),
        };
      }
    }
  }

  async #applyWithRetry(preset: Preset, retry: boolean): Promise<void> {
    try {
      await this.#system.applyPreset(preset);
    } catch (error) {
      if (!retry) {
        throw error;
      }

      this.#logger.warn({ err: error }, 'applying the announcement preset failed, retrying once');
      await this.#system.applyPreset(preset);
    }
  }

  #waitForTopology(expected: (zones: Zone[]) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#system.off('topology-change', listener);
        this.#logger.warn('players did not regroup in time, playing anyway');
        resolve();
      }, this.#topologyTimeoutMs);
      const listener = (zones: Zone[]): void => {
        if (expected(zones)) {
          clearTimeout(timer);
          this.#system.off('topology-change', listener);
          resolve();
        }
      };
      this.#system.on('topology-change', listener);
    });
  }

  /** Resolves when the clip stops (checked after half its length) or after its length plus a margin. */
  async #waitForEnd(player: Player, durationMs: number): Promise<void> {
    const started = Date.now();
    await sleep(durationMs / 2);

    await new Promise<void>((resolve) => {
      const remaining = Math.max(0, durationMs + RESTORE_MARGIN_MS - (Date.now() - started));
      const timer = setTimeout(finish, remaining);
      function finish(): void {
        clearTimeout(timer);
        player.off('transport-state', onTransportState);
        resolve();
      }
      function onTransportState(state: { playbackState: string }): void {
        if (state.playbackState === 'STOPPED') {
          finish();
        }
      }
      player.on('transport-state', onTransportState);
    });
  }

  async #restore(backups: Backup[]): Promise<void> {
    for (const backup of backups) {
      const preset = restorePreset(this.#system, backup);
      this.#logger.debug({ preset }, 'restoring');
      try {
        await this.#system.applyPreset(preset);
      } catch (error) {
        this.#logger.warn(
          { err: error, rooms: preset.players.map((p) => p.roomName) },
          'restore failed',
        );
      }
    }
  }
}
