/**
 * Shared core of the live integration tests (test/live): drives the HTTP API, snapshots the state
 * of the rooms a test may touch, restores it afterwards and asserts nothing else changed. It only
 * speaks HTTP, so the same class runs over `app.request()` against fakes (unit tests) and over
 * fetch against the real system (live tests).
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LiveGate {
  enabled: boolean;
  reason?: string;
}

/** Live tests run only when explicitly asked for. */
export function liveGate(env: Record<string, string | undefined>): LiveGate {
  if (env.SONOS_LIVE === '1') {
    return { enabled: true };
  }

  return { enabled: false, reason: 'SONOS_LIVE is not set to 1' };
}

export const DEFAULT_LIVE_ROOMS = ['1. Dining Room', '1. Kitchen'];

/** `SONOS_LIVE_ROOMS`: comma-separated rooms the tests may control (and make noise in). */
export function parseRooms(value: string | undefined): string[] {
  const rooms = (value ?? '')
    .split(',')
    .map((room) => room.trim())
    .filter((room) => room.length > 0);
  return rooms.length > 0 ? rooms : [...DEFAULT_LIVE_ROOMS];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface PlayModeSnapshot {
  repeat: string;
  shuffle: boolean;
  crossfade: boolean;
}

/** What a test may change in a room and must put back. */
export interface RoomSnapshot {
  uuid: string;
  /** Uuid of the room's group coordinator (its own uuid when standalone). */
  coordinator: string;
  /** Uuids of every member of the room's group, sorted. */
  members: string[];
  volume: number;
  mute: boolean;
  playbackState: string;
  uri: string;
  playMode: PlayModeSnapshot;
}

export type Snapshot = Record<string, RoomSnapshot>;

export type RoomField = Exclude<keyof RoomSnapshot, 'uuid'>;

export interface CompareOptions {
  /** Fields to leave out of the comparison (e.g. `uri` when music may change track). */
  ignore?: RoomField[];
}

export interface AssertRestoredOptions extends CompareOptions {
  settleMs?: number;
}

export interface LiveHarnessOptions {
  fetch: FetchLike;
  rooms: string[];
  /** How long assertRestored keeps re-reading before giving up (events settle asynchronously). */
  settleMs?: number;
  /** A room whose queue may be clobbered; without it, only a room with an empty queue is used. */
  scratchRoom?: string;
}

interface ZoneMemberJson {
  uuid: string;
  roomName: string;
  coordinator: string;
  state: {
    volume: number;
    mute: boolean;
    playbackState: string;
    currentTrack: { uri: string };
    playMode: PlayModeSnapshot;
  };
}

interface ZoneJson {
  uuid: string;
  coordinator: ZoneMemberJson;
  members: ZoneMemberJson[];
}

function isPlaying(state: string): boolean {
  return state === 'PLAYING' || state === 'TRANSITIONING';
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export class LiveHarness {
  readonly rooms: string[];
  readonly fetch: FetchLike;
  /** How long read-backs may take to reflect a command (events arrive asynchronously). */
  readonly settleMs: number;
  readonly #scratchRoom: string | undefined;

  constructor(options: LiveHarnessOptions) {
    this.fetch = options.fetch;
    this.rooms = [...options.rooms];
    this.settleMs = options.settleMs ?? 0;
    this.#scratchRoom = options.scratchRoom;
  }

  /** GET a path and parse the JSON body (text when the response is not JSON). */
  async get(path: string): Promise<ApiResponse> {
    return this.request(path);
  }

  async request(path: string, init?: RequestInit): Promise<ApiResponse> {
    const response = await this.fetch(path, init);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON; keep the text
    }

    return { status: response.status, body };
  }

  /** Convenience for `/{room}/{action}/{values...}`. */
  async action(room: string, action: string, ...values: string[]): Promise<ApiResponse> {
    const path = [room, action, ...values].map(encodeSegment).join('/');
    return this.get(`/${path}`);
  }

  async zones(): Promise<ZoneJson[]> {
    const response = await this.get('/zones');
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new Error(`/zones answered ${response.status}: ${JSON.stringify(response.body)}`);
    }

    return response.body as ZoneJson[];
  }

  /** The state of the listed rooms, keyed by room name. */
  async snapshot(rooms: string[] = this.rooms): Promise<Snapshot> {
    const wanted = new Set(rooms.map((room) => room.toLowerCase()));
    const snapshot: Snapshot = {};
    for (const zone of await this.zones()) {
      const members = zone.members.map((member) => member.uuid).sort();
      for (const member of zone.members) {
        if (!wanted.has(member.roomName.toLowerCase())) {
          continue;
        }

        snapshot[member.roomName] = {
          uuid: member.uuid,
          coordinator: member.coordinator,
          members,
          volume: member.state.volume,
          mute: member.state.mute,
          playbackState: member.state.playbackState,
          uri: member.state.currentTrack.uri,
          playMode: { ...member.state.playMode },
        };
      }
    }

    return snapshot;
  }

  /** Human-readable differences between two snapshots; empty when equivalent. */
  static differences(before: Snapshot, after: Snapshot, options: CompareOptions = {}): string[] {
    const ignored = new Set(options.ignore ?? []);
    const lines: string[] = [];
    for (const [room, was] of Object.entries(before)) {
      const now = after[room];
      if (!now) {
        lines.push(`${room}: missing from the topology`);
        continue;
      }

      const diff = (field: RoomField, a: unknown, b: unknown): void => {
        if (!ignored.has(field) && JSON.stringify(a) !== JSON.stringify(b)) {
          lines.push(`${room}: ${field} ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
        }
      };
      diff('coordinator', was.coordinator, now.coordinator);
      diff('members', was.members, now.members);
      diff('volume', was.volume, now.volume);
      diff('mute', was.mute, now.mute);
      diff('uri', was.uri, now.uri);
      diff('playMode', was.playMode, now.playMode);
      if (isPlaying(was.playbackState) !== isPlaying(now.playbackState)) {
        diff('playbackState', was.playbackState, now.playbackState);
      }
    }

    return lines;
  }

  /** Fails with every difference listed unless the rooms are back in the snapshotted state. */
  async assertRestored(before: Snapshot, options: AssertRestoredOptions = {}): Promise<void> {
    const deadline = Date.now() + (options.settleMs ?? this.settleMs);
    let differences: string[];
    for (;;) {
      differences = LiveHarness.differences(
        before,
        await this.snapshot(Object.keys(before)),
        options,
      );
      if (differences.length === 0) {
        return;
      }

      if (Date.now() >= deadline) {
        break;
      }

      await sleep(250);
    }

    assert.fail(`rooms were not restored:\n  ${differences.join('\n  ')}`);
  }

  /** Re-reads until `consecutive` snapshots in a row agree (players have reported their state). */
  async waitUntilStable(
    rooms: string[],
    options: { timeoutMs: number; intervalMs?: number; consecutive?: number },
  ) {
    const interval = options.intervalMs ?? 1000;
    const needed = Math.max(1, (options.consecutive ?? 2) - 1);
    const deadline = Date.now() + options.timeoutMs;
    let previous = await this.snapshot(rooms);
    let agreed = 0;
    while (Date.now() < deadline) {
      await sleep(interval);
      const current = await this.snapshot(rooms);
      agreed = LiveHarness.differences(previous, current).length === 0 ? agreed + 1 : 0;
      if (agreed >= needed) {
        return current;
      }

      previous = current;
    }

    return previous;
  }

  /** Snapshots, runs the test body, then puts the rooms back through the API; failures rethrow. */
  async withRestore<T>(fn: (before: Snapshot) => Promise<T>, rooms?: string[]): Promise<T> {
    const before = await this.snapshot(rooms);
    try {
      return await fn(before);
    } finally {
      await this.restore(before);
    }
  }

  /** Undoes grouping, volume, mute, play mode and play/pause changes relative to `before`. */
  async restore(before: Snapshot): Promise<void> {
    const after = await this.snapshot(Object.keys(before));
    const roomByUuid = new Map<string, string>();
    const coordinatorByUuid = new Map<string, string>();
    for (const zone of await this.zones()) {
      for (const member of zone.members) {
        roomByUuid.set(member.uuid, member.roomName);
        coordinatorByUuid.set(member.uuid, member.coordinator);
      }
    }

    // Leave groups first so that re-joins below see the final coordinators.
    for (const [room, was] of Object.entries(before)) {
      const now = after[room];
      if (now && was.coordinator === was.uuid && now.coordinator !== now.uuid) {
        await this.action(room, 'leave');
      }
    }

    for (const [room, was] of Object.entries(before)) {
      const now = after[room];
      if (!now) {
        continue;
      }

      if (was.coordinator !== was.uuid && now.coordinator !== was.coordinator) {
        const target = roomByUuid.get(was.coordinator);
        if (target) {
          await this.action(room, 'join', target);
        }
      }

      // A coordinator whose members were pulled away by the test gets them back.
      if (was.coordinator === was.uuid) {
        for (const memberUuid of was.members) {
          const memberRoom = roomByUuid.get(memberUuid);
          if (
            memberUuid !== was.uuid &&
            memberRoom &&
            coordinatorByUuid.get(memberUuid) !== was.uuid
          ) {
            await this.action(room, 'add', memberRoom);
          }
        }
      }

      if (now.volume !== was.volume) {
        await this.action(room, 'volume', String(was.volume));
      }

      if (now.mute !== was.mute) {
        await this.action(room, was.mute ? 'mute' : 'unmute');
      }

      if (was.coordinator === was.uuid) {
        if (now.playMode.repeat !== was.playMode.repeat) {
          await this.action(room, 'repeat', was.playMode.repeat);
        }

        if (now.playMode.shuffle !== was.playMode.shuffle) {
          await this.action(room, 'shuffle', was.playMode.shuffle ? 'on' : 'off');
        }

        if (now.playMode.crossfade !== was.playMode.crossfade) {
          await this.action(room, 'crossfade', was.playMode.crossfade ? 'on' : 'off');
        }

        // A room that was idle on its queue (or on nothing) is pointed back at its queue; a
        // stream or track it was on cannot be reproduced safely and is left for the assertion.
        const idleUri = was.uri === '' || was.uri.startsWith('x-rincon-queue:');
        if (idleUri && now.uri !== was.uri && !now.uri.startsWith('x-rincon-queue:')) {
          await this.action(room, 'setavtransporturi', `x-rincon-queue:${was.uuid}#0`);
        }

        if (isPlaying(was.playbackState) !== isPlaying(now.playbackState)) {
          await this.action(room, isPlaying(was.playbackState) ? 'play' : 'pause');
        }
      }
    }
  }

  /**
   * A room whose queue may be replaced: the configured scratch room, else the first test room
   * whose queue is already empty.
   */
  async scratchRoom(): Promise<string | undefined> {
    if (this.#scratchRoom) {
      return this.#scratchRoom;
    }

    for (const room of this.rooms) {
      const queue = await this.action(room, 'queue');
      if (queue.status === 200 && Array.isArray(queue.body) && queue.body.length === 0) {
        return room;
      }
    }

    return undefined;
  }
}
