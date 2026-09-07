import type { Player, Zone } from '../discovery/player.ts';
import type { Preset } from '../discovery/types.ts';

/** The subset of SonosSystem an announcement needs. */
export interface AnnounceSystem {
  zones: Zone[];
  players: Player[];
  applyPreset(preset: Preset): Promise<void>;
  on(event: 'topology-change', listener: (zones: Zone[]) => void): unknown;
  off(event: 'topology-change', listener: (zones: Zone[]) => void): unknown;
}

export type AnnounceTarget =
  | { kind: 'player'; player: Player }
  | { kind: 'all' }
  | { kind: 'preset'; preset: Preset; name?: string | undefined }
  /** An ad-hoc set of rooms, the first one leading; a room's own volume wins over the spec's. */
  | { kind: 'rooms'; rooms: Array<{ player: Player; volume?: number | undefined }> };

/** `urgent` (a doorbell) interrupts a playing `normal` announcement, which resumes afterwards. */
export type AnnouncementPriority = 'normal' | 'urgent';

/** A clip the players can fetch: an absolute url and how long it plays. */
export interface PreparedClip {
  uri: string;
  durationMs: number;
  /** Whether the clip came from the cache (text-to-speech) rather than being synthesized now. */
  cached?: boolean | undefined;
}

export interface AnnouncementSpec {
  target: AnnounceTarget;
  /** Default `normal`. */
  priority?: AnnouncementPriority | undefined;
  /** Volume for every player; a preset's own volumes apply when this is absent. */
  volume?: number | undefined;
  /** Pause the groups not taking part; defaults to the preset's setting (true when unset). */
  pauseOthers?: boolean | undefined;
  /** Produces the clip; called once at submit so synthesis overlaps the queue wait and grouping. */
  prepare: () => Promise<PreparedClip>;
  /** What asked for the announcement (`say`, `clip`, ...), for logs and results. */
  source: string;
  /** The start of the text, or the clip name, for the history. */
  textPreview?: string | undefined;
  requestId?: string | undefined;
  /** A caller's key for "do not play this twice" (see POST /announce). */
  idempotencyKey?: string | undefined;
}

export type AnnouncementState =
  | 'queued'
  | 'starting'
  | 'playing'
  /** Paused by an urgent announcement; goes back to `playing` when that one is done. */
  | 'interrupted'
  | 'restoring'
  | 'done'
  | 'failed'
  | 'cancelled';

/** How long each stage took, in milliseconds; a stage that never ran is absent. */
export interface StageTimings {
  queuedMs?: number;
  prepareMs?: number;
  groupMs?: number;
  topologyMs?: number;
  playMs?: number;
  restoreMs?: number;
  totalMs: number;
}

export interface AnnouncementResult {
  id: string;
  state: 'done' | 'cancelled';
  source: string;
  priority: AnnouncementPriority;
  rooms: string[];
  /** How many times an urgent announcement paused this one. */
  interruptions: number;
  /** Absent when the announcement was cancelled before its clip was needed. */
  clip?: PreparedClip | undefined;
  /** Whether every room was put back as it was; `partial` comes with `warnings`. */
  restore: 'ok' | 'partial';
  warnings: string[];
  timings: StageTimings;
}

export interface AnnouncementHandle {
  id: string;
  /** Resolves when the rooms have been restored; rejects with the error that stopped playback. */
  done: Promise<AnnouncementResult>;
  /** Drops a queued announcement, or stops a playing one and restores the rooms. */
  cancel(): void;
}

/** One state change of an announcement, with what the history and event clients need. */
export interface AnnouncementTransition {
  id: string;
  state: AnnouncementState;
  /** Absent on `queued`, the first state. */
  previousState: AnnouncementState | undefined;
  source: string;
  priority: AnnouncementPriority;
  /** See `describeTarget`. */
  target: string;
  textPreview?: string | undefined;
  requestId?: string | undefined;
  idempotencyKey?: string | undefined;
  at: number;
  /** Known once the announcement has been planned. */
  rooms?: string[] | undefined;
  /** With `done` and `cancelled`. */
  result?: AnnouncementResult | undefined;
  /** With `failed`. */
  error?: string | undefined;
}
