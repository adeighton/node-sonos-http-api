import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError, ServiceUnavailableError } from '../http/errors.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { planAnnouncement } from './plan.ts';

function house() {
  const system = new FakeSystem();
  const kitchen = createTestPlayer({ system, roomName: 'Kitchen', uuid: 'RINCON_K' }).player;
  const office = createTestPlayer({ system, roomName: 'Office', uuid: 'RINCON_O' }).player;
  const den = createTestPlayer({ system, roomName: 'Den', uuid: 'RINCON_D' }).player;
  system.addStandalone(kitchen);
  system.addStandalone(office);
  system.addStandalone(den);
  return { system, kitchen, office, den };
}

describe('planAnnouncement', () => {
  it('plans one room: its own volume, no pausing, ready once it stands alone', () => {
    const { system, kitchen, office } = house();

    const plan = planAnnouncement(system, {
      target: { kind: 'player', player: kitchen },
      volume: 40,
    });

    assert.equal(plan.coordinator, kitchen);
    assert.deepEqual(plan.preset, {
      players: [{ roomName: 'Kitchen', volume: 40 }],
      playMode: { repeat: 'none' },
      pauseOthers: false,
      state: 'STOPPED',
    });
    assert.equal(plan.expectedTopology(system.zones), true);
    const grouped = system.zones.map((zone) =>
      zone.uuid === 'RINCON_K' ? { ...zone, members: [kitchen, office] } : zone,
    );
    assert.equal(plan.expectedTopology(grouped), false, 'still has a member');
  });

  it('plans every room through the biggest group and pauses nothing else (there is nothing else)', () => {
    const { system, kitchen, office, den } = house();
    system.zones[1]?.members.push(den);
    office.coordinator = office;
    den.coordinator = office;
    system.zones.splice(2, 1);

    const plan = planAnnouncement(system, { target: { kind: 'all' }, volume: 30 });

    assert.equal(plan.coordinator, office, 'the biggest group leads');
    assert.deepEqual(plan.preset.players, [
      { roomName: 'Office', volume: 30 },
      { roomName: 'Kitchen', volume: 30 },
      { roomName: 'Den', volume: 30 },
    ]);
    assert.equal(plan.preset.pauseOthers, true);
    assert.equal(plan.expectedTopology(system.zones), false);
    assert.equal(
      plan.expectedTopology([
        { uuid: 'RINCON_O', id: 'x', coordinator: office, members: [den, kitchen, office] },
      ]),
      true,
      'member order does not matter',
    );
    assert.throws(
      () => planAnnouncement(new FakeSystem(), { target: { kind: 'all' } }),
      ServiceUnavailableError,
    );
  });

  it('plans a preset with its rooms and volumes, honouring its pauseOthers', () => {
    const { system, kitchen, office } = house();
    const preset = {
      players: [
        { roomName: 'kitchen', volume: 60 },
        { roomName: 'Office', volume: 20 },
      ],
      pauseOthers: false,
      playMode: { repeat: 'all' as const },
    };

    const plan = planAnnouncement(system, { target: { kind: 'preset', preset } });

    assert.equal(plan.coordinator, kitchen, 'rooms are matched case-insensitively');
    assert.deepEqual(plan.preset, {
      players: preset.players,
      playMode: { repeat: 'all' },
      pauseOthers: false,
      state: 'STOPPED',
    });
    assert.equal(plan.expectedTopology(system.zones), false);
    assert.equal(
      plan.expectedTopology([
        { uuid: 'RINCON_K', id: 'x', coordinator: kitchen, members: [kitchen, office] },
      ]),
      true,
    );
  });

  it('lets the request override a preset volume and pauseOthers, defaulting pauseOthers to true', () => {
    const { system } = house();
    const preset = { players: [{ roomName: 'Kitchen', volume: 60 }, { roomName: 'Office' }] };

    const plain = planAnnouncement(system, { target: { kind: 'preset', preset } });
    assert.equal(plain.preset.pauseOthers, true);
    assert.deepEqual(plain.preset.players, preset.players);

    const overridden = planAnnouncement(system, {
      target: { kind: 'preset', preset },
      volume: 15,
      pauseOthers: false,
    });
    assert.equal(overridden.preset.pauseOthers, false);
    assert.deepEqual(overridden.preset.players, [
      { roomName: 'Kitchen', volume: 15 },
      { roomName: 'Office', volume: 15 },
    ]);
  });

  it('plans ad-hoc rooms, the first one leading, each with its own volume over the default', () => {
    const { system, kitchen, office } = house();

    const plan = planAnnouncement(system, {
      target: {
        kind: 'rooms',
        rooms: [{ player: office, volume: 25 }, { player: kitchen }],
      },
      volume: 40,
    });

    assert.equal(plan.coordinator, office);
    assert.deepEqual(plan.preset, {
      players: [
        { roomName: 'Office', volume: 25 },
        { roomName: 'Kitchen', volume: 40 },
      ],
      playMode: { repeat: 'none' },
      pauseOthers: false,
      state: 'STOPPED',
    });
    assert.equal(plan.expectedTopology(system.zones), false);
    assert.equal(
      plan.expectedTopology([
        { uuid: 'RINCON_O', id: 'x', coordinator: office, members: [kitchen, office] },
      ]),
      true,
    );
    assert.throws(
      () => planAnnouncement(system, { target: { kind: 'rooms', rooms: [] } }),
      BadRequestError,
    );
  });

  it('rejects a preset whose first room is unknown or missing', () => {
    const { system } = house();
    assert.throws(
      () =>
        planAnnouncement(system, {
          target: { kind: 'preset', preset: { players: [{ roomName: 'Attic' }] } },
        }),
      (error: unknown) =>
        error instanceof BadRequestError && /Attic.*not a known player/.test(error.message),
    );
    assert.throws(
      () => planAnnouncement(system, { target: { kind: 'preset', preset: { players: [] } } }),
      BadRequestError,
    );
  });
});
