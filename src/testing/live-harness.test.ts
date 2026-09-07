import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { createActionRegistry } from '../actions/index.ts';
import { createApp } from '../app.ts';
import { settingsSchema } from '../config/schema.ts';
import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { EventHub } from '../http/events.ts';
import { silentLogger } from '../logger.ts';
import { PresetStore } from '../presets/store.ts';
import { FakeSystem } from './fake-system.ts';
import { fixturePath } from './fixtures.ts';
import { LiveHarness, liveGate, parseRooms } from './live-harness.ts';
import { createTestPlayer } from './test-player.ts';

const EMPTY_BROWSE_RESPONSE =
  '<s:Envelope><s:Body><u:BrowseResponse><Result></Result><NumberReturned>0</NumberReturned><TotalMatches>0</TotalMatches></u:BrowseResponse></s:Body></s:Envelope>';

/** A real app over a FakeSystem with two standalone rooms, driven through app.request. */
function harnessOverFakes(roomNames = ['Kitchen', 'Den']) {
  const system = new FakeSystem();
  const rooms = new Map(
    roomNames.map((name, index) => {
      const created = createTestPlayer({ system, roomName: name, uuid: `RINCON_${index}` });
      system.addStandalone(created.player);
      return [name, created];
    }),
  );
  const settings = settingsSchema.parse({});
  const app = createApp({
    system,
    settings,
    registry: createActionRegistry({ cacheDir: '/tmp' }),
    presets: new PresetStore('/nonexistent'),
    tts: { providers: [], speak: () => Promise.reject(new Error('no tts')) },
    clips: { get: () => Promise.reject(new Error('no clips')) },
    announcer: { announce: () => Promise.resolve() },
    hub: new EventHub({ logger: silentLogger }),
    logger: silentLogger,
    version: 'test',
    publicBaseUrl: () => 'http://127.0.0.1:5005',
  });
  const harness = new LiveHarness({
    fetch: async (url, init) => app.request(url, init),
    rooms: roomNames,
  });
  return { harness, system, rooms };
}

describe('liveGate', () => {
  it('is off unless SONOS_LIVE=1 and explains why', () => {
    assert.deepEqual(liveGate({}), { enabled: false, reason: 'SONOS_LIVE is not set to 1' });
    assert.deepEqual(liveGate({ SONOS_LIVE: '0' }), {
      enabled: false,
      reason: 'SONOS_LIVE is not set to 1',
    });
    assert.deepEqual(liveGate({ SONOS_LIVE: '1' }), { enabled: true });
  });

  it('parses the room list with a default', () => {
    assert.deepEqual(parseRooms(undefined), ['1. Dining Room', '1. Kitchen']);
    assert.deepEqual(parseRooms(' Den , Office '), ['Den', 'Office']);
    assert.deepEqual(parseRooms(''), ['1. Dining Room', '1. Kitchen']);
  });
});

describe('LiveHarness', () => {
  it('requests json through the app and reports the status', async () => {
    const { harness } = harnessOverFakes();

    const zones = await harness.get('/zones');
    assert.equal(zones.status, 200);
    assert.ok(Array.isArray(zones.body));

    const missing = await harness.get('/nope');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { status: 'error', error: "Action 'nope' not found" });
  });

  it('snapshots the test rooms and detects a change in volume, mute, group or transport', async () => {
    const { harness, rooms } = harnessOverFakes();
    const kitchen = rooms.get('Kitchen');
    const den = rooms.get('Den');
    assert.ok(kitchen && den);

    const before = await harness.snapshot();
    assert.deepEqual(Object.keys(before).sort(), ['Den', 'Kitchen']);
    assert.equal(before.Kitchen?.coordinator, 'RINCON_0');
    assert.deepEqual(before.Kitchen?.members, ['RINCON_0']);

    await assert.doesNotReject(harness.assertRestored(before));

    await kitchen.player.handleLastChange({ volume: [{ channel: 'Master', val: '33' }] });
    await assert.rejects(harness.assertRestored(before), /Kitchen.*volume.*33/);

    const afterVolume = await harness.snapshot();
    await kitchen.player.handleLastChange({ mute: [{ channel: 'Master', val: '1' }] });
    await assert.rejects(harness.assertRestored(afterVolume), /Kitchen.*mute/);

    const afterMute = await harness.snapshot();
    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      avtransporturi: { val: 'x-rincon-mp3radio://stream' },
    });
    await assert.rejects(harness.assertRestored(afterMute), /Kitchen.*(uri|playbackState)/);
  });

  it('treats TRANSITIONING as PLAYING and ignores rooms outside the list', async () => {
    const { harness, rooms } = harnessOverFakes(['Kitchen', 'Den']);
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    await kitchen.player.handleLastChange({ transportstate: { val: 'PLAYING' } });
    const before = await harness.snapshot();

    await kitchen.player.handleLastChange({ transportstate: { val: 'TRANSITIONING' } });
    await assert.doesNotReject(harness.assertRestored(before));

    const kitchenOnly = new LiveHarness({
      fetch: (url, init) => harness.fetch(url, init),
      rooms: ['Kitchen'],
    });
    const narrow = await kitchenOnly.snapshot();
    const den = rooms.get('Den');
    assert.ok(den);
    await den.player.handleLastChange({ volume: [{ channel: 'Master', val: '77' }] });
    await assert.doesNotReject(kitchenOnly.assertRestored(narrow));
  });

  it('withRestore puts volume, mute, play mode and grouping back through the API', async () => {
    const { harness, rooms } = harnessOverFakes();
    const kitchen = rooms.get('Kitchen');
    const den = rooms.get('Den');
    assert.ok(kitchen && den);
    await kitchen.player.handleLastChange({
      volume: [{ channel: 'Master', val: '20' }],
      mute: [{ channel: 'Master', val: '0' }],
    });

    await harness.withRestore(async () => {
      await kitchen.player.handleLastChange({
        volume: [{ channel: 'Master', val: '50' }],
        mute: [{ channel: 'Master', val: '1' }],
        transportstate: { val: 'STOPPED' },
        currentplaymode: { val: 'SHUFFLE_NOREPEAT' },
      });
      den.player.coordinator = kitchen.player; // Den joined Kitchen's group
      kitchen.soap.calls.length = 0;
      den.soap.calls.length = 0;
    });

    const kitchenActions = kitchen.soap.calls.map((call) => call.action);
    assert.ok(kitchenActions.includes(SOAP_ACTIONS.Volume), 'volume restored');
    assert.equal(
      kitchen.soap.calls.find((c) => c.action === SOAP_ACTIONS.Volume)?.values?.volume,
      20,
    );
    assert.ok(kitchenActions.includes(SOAP_ACTIONS.Mute), 'mute restored');
    assert.ok(kitchenActions.includes(SOAP_ACTIONS.SetPlayMode), 'play mode restored');
    assert.ok(
      den.soap.calls.some((c) => c.action === SOAP_ACTIONS.BecomeCoordinatorOfStandaloneGroup),
      'Den leaves the group it joined',
    );
  });

  it('ignores the listed fields when comparing, and waits until two reads agree', async () => {
    const { harness, rooms } = harnessOverFakes();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const before = await harness.snapshot();

    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      avtransporturi: { val: 'x-rincon-mp3radio://stream' },
    });
    await assert.rejects(harness.assertRestored(before), /Kitchen/);
    await assert.doesNotReject(
      harness.assertRestored(before, { ignore: ['uri', 'playbackState'] }),
    );

    const stable = await harness.waitUntilStable(['Kitchen'], { timeoutMs: 500, intervalMs: 10 });
    assert.equal(stable.Kitchen?.playbackState, 'PLAYING');
  });

  it('restore points an idle room back at its queue when a test changed its transport', async () => {
    const { harness, rooms } = harnessOverFakes();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const before = await harness.snapshot(['Kitchen']);
    assert.equal(before.Kitchen?.uri, '');

    await kitchen.player.handleLastChange({
      transportstate: { val: 'STOPPED' },
      avtransporturi: { val: 'x-sonosapi-stream:s1?sid=254' },
    });
    kitchen.soap.calls.length = 0;
    await harness.restore(before);

    assert.equal(
      kitchen.soap.calls.find((c) => c.action === SOAP_ACTIONS.SetAVTransportURI)?.values?.uri,
      'x-rincon-queue:RINCON_0#0',
    );
  });

  it('withRestore rethrows the test failure after restoring', async () => {
    const { harness } = harnessOverFakes();
    await assert.rejects(
      harness.withRestore(() => Promise.reject(new Error('test failed'))),
      /test failed/,
    );
  });

  it('scratchRoom returns the first room with an empty queue, or undefined', async () => {
    const { harness, rooms } = harnessOverFakes();
    const kitchen = rooms.get('Kitchen');
    const den = rooms.get('Den');
    assert.ok(kitchen && den);

    // Both rooms answer the queue browse with real tracks: nothing is scratch.
    kitchen.soap.queueResponse(createReadStream(fixturePath('queue.xml')));
    den.soap.queueResponse(createReadStream(fixturePath('queue.xml')));
    assert.equal(await harness.scratchRoom(), undefined);

    // Kitchen's queue is empty on the next look.
    kitchen.soap.queueResponse(Readable.from([EMPTY_BROWSE_RESPONSE]));
    assert.equal(await harness.scratchRoom(), 'Kitchen');

    // A configured scratch room wins without looking at any queue.
    const configured = new LiveHarness({
      fetch: harness.fetch,
      rooms: ['Kitchen', 'Den'],
      scratchRoom: 'Den',
    });
    assert.equal(await configured.scratchRoom(), 'Den');
  });

  it('restore re-adds group members a test pulled away from a listed coordinator', async () => {
    const { harness, rooms } = harnessOverFakes(['Kitchen', 'Den']);
    const den = rooms.get('Den');
    assert.ok(den);
    // Only Kitchen is a test room; the snapshot says Den used to be one of its members.
    const kitchenOnly = new LiveHarness({ fetch: harness.fetch, rooms: ['Kitchen'] });
    const before = await kitchenOnly.snapshot();
    const kitchen = before.Kitchen;
    assert.ok(kitchen);
    den.soap.calls.length = 0;

    await kitchenOnly.restore({ Kitchen: { ...kitchen, members: ['RINCON_0', 'RINCON_1'] } });

    assert.ok(
      den.soap.calls.some((c) => String(c.values?.uri) === 'x-rincon:RINCON_0'),
      'Den was told to rejoin Kitchen',
    );
  });
});
