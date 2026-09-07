/**
 * Behavioural contracts of the HTTP API that hold both for the fake system (unit tests) and for
 * a real Sonos system (test/live). Each helper drives the API through a LiveHarness and reads the
 * effect back through /state or /zones, so the live suite reuses these instead of restating them.
 *
 * Where the real system reports an effect only through a UPnP event (mute, play mode, grouping),
 * the fake cannot produce that event by itself; the unit test passes `afterCommand` to feed the
 * event the real player would send.
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import type { LiveHarness } from './live-harness.ts';

export interface ContractHooks {
  /** Runs after each command the contract sends, before the read-back is checked. */
  afterCommand?: (action: string, value: string | undefined) => Promise<void>;
}

interface StateJson {
  volume: number;
  mute: boolean;
  playbackState: string;
  trackNo: number;
  elapsedTime: number;
  currentTrack: { uri: string; title: string; artist: string };
  playMode: { repeat: string; shuffle: boolean; crossfade: boolean };
}

async function readState(harness: LiveHarness, room: string): Promise<StateJson> {
  const response = await harness.action(room, 'state');
  assert.equal(response.status, 200, `${room}/state: ${JSON.stringify(response.body)}`);
  return response.body as StateJson;
}

/** Re-reads until `check` passes or the harness's settle window elapses; throws the last failure. */
async function eventually(harness: LiveHarness, check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + harness.settleMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }

      await sleep(250);
    }
  }
}

async function command(
  harness: LiveHarness,
  hooks: ContractHooks,
  room: string,
  action: string,
  value?: string,
): Promise<void> {
  const response = await harness.action(room, action, ...(value === undefined ? [] : [value]));
  assert.equal(
    response.status,
    200,
    `${room}/${action}${value === undefined ? '' : `/${value}`}: ${JSON.stringify(response.body)}`,
  );
  await hooks.afterCommand?.(action, value);
}

/** Absolute and relative volume changes are accepted and read back; the volume is put back. */
export async function expectVolumeRoundTrip(
  harness: LiveHarness,
  room: string,
  hooks: ContractHooks = {},
): Promise<void> {
  const original = (await readState(harness, room)).volume;
  const target = original === 15 ? 20 : 15;
  try {
    await command(harness, hooks, room, 'volume', String(target));
    await eventually(harness, async () =>
      assert.equal((await readState(harness, room)).volume, target),
    );

    await command(harness, hooks, room, 'volume', '+5');
    await eventually(harness, async () =>
      assert.equal((await readState(harness, room)).volume, target + 5),
    );

    await command(harness, hooks, room, 'volume', '-5');
    await eventually(harness, async () =>
      assert.equal((await readState(harness, room)).volume, target),
    );
  } finally {
    await command(harness, hooks, room, 'volume', String(original));
  }
}

/** mute / unmute / togglemute read back; the mute state is put back. */
export async function expectMuteRoundTrip(
  harness: LiveHarness,
  room: string,
  hooks: ContractHooks = {},
): Promise<void> {
  const original = (await readState(harness, room)).mute;
  try {
    await command(harness, hooks, room, 'mute');
    await eventually(harness, async () =>
      assert.equal((await readState(harness, room)).mute, true),
    );

    await command(harness, hooks, room, 'unmute');
    await eventually(harness, async () =>
      assert.equal((await readState(harness, room)).mute, false),
    );
  } finally {
    await command(harness, hooks, room, original ? 'mute' : 'unmute');
  }
}

/** repeat / shuffle / crossfade read back; the play mode is put back. */
export async function expectPlayModeRoundTrip(
  harness: LiveHarness,
  room: string,
  hooks: ContractHooks = {},
): Promise<void> {
  const original = (await readState(harness, room)).playMode;
  const read = async () => (await readState(harness, room)).playMode;
  try {
    await command(harness, hooks, room, 'repeat', 'all');
    await eventually(harness, async () => assert.equal((await read()).repeat, 'all'));
    await command(harness, hooks, room, 'repeat', 'none');
    await eventually(harness, async () => assert.equal((await read()).repeat, 'none'));

    await command(harness, hooks, room, 'shuffle', 'on');
    await eventually(harness, async () => assert.equal((await read()).shuffle, true));
    await command(harness, hooks, room, 'shuffle', 'off');
    await eventually(harness, async () => assert.equal((await read()).shuffle, false));

    await command(harness, hooks, room, 'crossfade', 'on');
    await eventually(harness, async () => assert.equal((await read()).crossfade, true));
    await command(harness, hooks, room, 'crossfade', 'off');
    await eventually(harness, async () => assert.equal((await read()).crossfade, false));
  } finally {
    await command(harness, hooks, room, 'repeat', original.repeat);
    await command(harness, hooks, room, 'shuffle', original.shuffle ? 'on' : 'off');
    await command(harness, hooks, room, 'crossfade', original.crossfade ? 'on' : 'off');
  }
}

async function coordinatorOf(harness: LiveHarness, room: string): Promise<string> {
  const snapshot = await harness.snapshot([room]);
  const entry = snapshot[room];
  assert.ok(entry, `${room} is in the topology`);
  return entry.coordinator;
}

async function uuidOf(harness: LiveHarness, room: string): Promise<string> {
  const snapshot = await harness.snapshot([room]);
  const entry = snapshot[room];
  assert.ok(entry, `${room} is in the topology`);
  return entry.uuid;
}

/** `member` joins `coordinatorRoom`'s group and leaves it again, visible in /zones. */
export async function expectGroupingRoundTrip(
  harness: LiveHarness,
  member: string,
  coordinatorRoom: string,
  hooks: ContractHooks = {},
): Promise<void> {
  const memberUuid = await uuidOf(harness, member);
  const coordinatorUuid = await uuidOf(harness, coordinatorRoom);
  assert.equal(await coordinatorOf(harness, member), memberUuid, `${member} starts standalone`);

  try {
    await command(harness, hooks, member, 'join', coordinatorRoom);
    await eventually(harness, async () =>
      assert.equal(await coordinatorOf(harness, member), coordinatorUuid),
    );
  } finally {
    await command(harness, hooks, member, 'leave');
  }

  await eventually(harness, async () =>
    assert.equal(await coordinatorOf(harness, member), memberUuid),
  );
}

/** The /state document carries the fields clients rely on, with the right types. */
export async function expectStateShape(harness: LiveHarness, room: string): Promise<void> {
  const state = await readState(harness, room);
  assert.equal(typeof state.volume, 'number');
  assert.equal(typeof state.mute, 'boolean');
  assert.equal(typeof state.playbackState, 'string');
  assert.equal(typeof state.trackNo, 'number');
  assert.equal(typeof state.elapsedTime, 'number');
  assert.equal(typeof state.currentTrack.uri, 'string');
  assert.equal(typeof state.currentTrack.title, 'string');
  assert.ok(['none', 'all', 'one'].includes(state.playMode.repeat), 'repeat mode is known');
  assert.equal(typeof state.playMode.shuffle, 'boolean');
  assert.equal(typeof state.playMode.crossfade, 'boolean');
}

/** /zones lists every group with its coordinator among its members. */
export async function expectZonesShape(harness: LiveHarness): Promise<void> {
  const zones = await harness.zones();
  assert.ok(zones.length > 0, 'at least one zone');
  for (const zone of zones) {
    assert.equal(typeof zone.uuid, 'string');
    assert.equal(typeof zone.coordinator.roomName, 'string');
    assert.ok(
      zone.members.some((member) => member.uuid === zone.coordinator.uuid),
      `${zone.coordinator.roomName}: the coordinator is one of the members`,
    );
    for (const member of zone.members) {
      assert.equal(
        member.coordinator,
        zone.coordinator.uuid,
        `${member.roomName} points at its coordinator`,
      );
    }
  }
}

/** Unknown action → 404, bad input → 400, non-GET → 405 with `Allow: GET`; bodies are JSON. */
export async function expectErrorContract(harness: LiveHarness, room: string): Promise<void> {
  const unknown = await harness.get('/nope');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { status: 'error', error: "Action 'nope' not found" });

  const badVolume = await harness.action(room, 'volume', 'loud');
  assert.equal(badVolume.status, 400);
  assert.equal((badVolume.body as { status: string }).status, 'error');

  const post = await harness.fetch('/zones', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
}
