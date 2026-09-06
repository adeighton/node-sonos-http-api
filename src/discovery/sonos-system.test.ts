import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it, mock } from 'node:test';

import { flushPromises } from '../testing/async.ts';
import { captureLogs } from '../testing/capture-logs.ts';
import { fakeSoapClient } from '../testing/fake-soap.ts';
import { fixturePath, readJsonFixture } from '../testing/fixtures.ts';
import { UnknownServiceError } from './errors.ts';
import type { HttpRequestOptions, HttpStreamResponse } from './http.ts';
import type { NotificationEvents } from './notification-listener.ts';
import { Player } from './player.ts';
import { SOAP_ACTIONS } from './soap.ts';
import { SonosSystem, coordinatorFromGroupId } from './sonos-system.ts';
import type { SonosSystemDeps, SsdpLike } from './sonos-system.ts';
import type { SsdpFound } from './ssdp.ts';
import type { SubscriberEvents } from './subscriber.ts';
import type { LastChangeData, ZoneGroupData } from './types.ts';

class FakeSsdp extends EventEmitter<{ found: [SsdpFound] }> implements SsdpLike {
  readonly start = mock.fn(() => undefined);
  readonly stop = mock.fn(() => undefined);
}

class FakeListener extends EventEmitter<NotificationEvents> {
  readonly endpoint = 'http://127.0.0.2:3500/';
  readonly listen = mock.fn(() => Promise.resolve(3500));
  readonly close = mock.fn(() => Promise.resolve());
}

class FakeSubscriber extends EventEmitter<SubscriberEvents> {
  readonly dispose = mock.fn(() => Promise.resolve());
  readonly url: string;
  readonly notificationUrl: string;

  constructor(url: string, notificationUrl: string) {
    super();
    this.url = url;
    this.notificationUrl = notificationUrl;
  }
}

const FOUND: SsdpFound = {
  ip: '127.0.0.1',
  location: 'http://127.0.0.1:1400/xml',
  household: 'Sonos_1234567890abcdef',
};

function streamResponse(): HttpStreamResponse {
  return {
    status: 200,
    statusMessage: 'OK',
    headers: {},
    localAddress: '127.0.0.2',
    stream: Readable.from([]),
  };
}

function setup(
  options: { household?: string; httpFails?: boolean; discoveryHosts?: string[] } = {},
) {
  const ssdp = new FakeSsdp();
  const listeners: FakeListener[] = [];
  const subscribers: FakeSubscriber[] = [];
  const soap = fakeSoapClient();
  const http = mock.fn((_options: HttpRequestOptions): Promise<HttpStreamResponse> =>
    options.httpFails
      ? Promise.reject(new Error('unreachable'))
      : Promise.resolve(streamResponse()),
  );
  const createPlayer = mock.fn(
    (...args: Parameters<SonosSystemDeps['createPlayer'] & object>) => new Player(...args),
  );
  const { logger, messages, entries } = captureLogs();

  const system = new SonosSystem(
    { household: options.household, discoveryHosts: options.discoveryHosts },
    {
      ssdp,
      http,
      soap,
      artLookup: () => Promise.reject(new Error('no art')),
      createListener: () => {
        const listener = new FakeListener();
        listeners.push(listener);
        return listener;
      },
      createSubscriber: (url, notificationUrl) => {
        const subscriber = new FakeSubscriber(url, notificationUrl);
        subscribers.push(subscriber);
        return subscriber;
      },
      createPlayer,
      logger,
    },
  );

  /** Runs discovery up to the point where the topology subscription exists. */
  async function discover(found: SsdpFound = FOUND) {
    system.start();
    ssdp.emit('found', found);
    await flushPromises();
  }

  function topology(fixture = 'topology.json') {
    const listener = listeners.at(-1);
    assert.ok(listener, 'listener not created');
    listener.emit('topology', 'RINCON_X', readJsonFixture<ZoneGroupData[]>(fixture));
  }

  return {
    system,
    ssdp,
    http,
    soap,
    listeners,
    subscribers,
    createPlayer,
    messages,
    entries,
    discover,
    topology,
    listener: () => {
      const listener = listeners.at(-1);
      assert.ok(listener);
      return listener;
    },
  };
}

describe('SonosSystem', () => {
  it('starts scanning once', () => {
    const { system, ssdp } = setup();

    system.start();
    system.start();

    assert.equal(ssdp.start.mock.callCount(), 1);
  });

  describe('when a player is found', () => {
    it('fetches the device description to learn the local endpoint', async () => {
      const { system, http, ssdp, discover } = setup();
      await discover();

      assert.equal(http.mock.callCount(), 1);
      assert.equal(http.mock.calls[0]?.arguments[0].method, 'GET');
      assert.equal(http.mock.calls[0]?.arguments[0].url, 'http://127.0.0.1:1400/xml');
      assert.equal(system.localEndpoint, '127.0.0.2');
      assert.equal(ssdp.stop.mock.callCount(), 1);
    });

    it('starts a notification listener and subscribes to topology events', async () => {
      const { discover, listeners, subscribers } = setup();
      await discover();

      assert.equal(listeners.length, 1);
      assert.equal(listeners[0]?.listen.mock.callCount(), 1);
      assert.equal(subscribers.length, 1);
      assert.equal(subscribers[0]?.url, 'http://127.0.0.1:1400/ZoneGroupTopology/Event');
      assert.equal(subscribers[0]?.notificationUrl, 'http://127.0.0.2:3500/');
    });

    it('restarts discovery when the topology subscription dies', async () => {
      const { discover, ssdp, subscribers, listeners, messages } = setup();
      await discover();

      subscribers[0]?.emit('dead', 'Mocked error');
      await flushPromises();

      assert.equal(subscribers[0]?.dispose.mock.callCount(), 1);
      assert.equal(listeners[0]?.close.mock.callCount(), 1);
      assert.equal(ssdp.start.mock.callCount(), 2);
      assert.ok(messages().includes('topology subscription died, restarting discovery'));
    });

    it('logs and restarts when the device description cannot be fetched', async () => {
      const { discover, ssdp, messages } = setup({ httpFails: true });
      await discover();

      assert.equal(ssdp.start.mock.callCount(), 2);
      assert.ok(messages().includes('discovery failed, retrying'));
    });
  });

  describe('household filter', () => {
    it('skips players from other households and keeps listening', async () => {
      const { discover, ssdp, http } = setup({ household: 'Sonos_asdg12335346345' });
      await discover(FOUND);

      assert.equal(http.mock.callCount(), 0);
      assert.equal(ssdp.stop.mock.callCount(), 0);

      ssdp.emit('found', {
        ip: '127.0.0.3',
        location: 'http://127.0.0.3:1400/xml',
        household: 'Sonos_asdg12335346345',
      });
      await flushPromises();

      assert.equal(http.mock.callCount(), 1);
      assert.equal(http.mock.calls[0]?.arguments[0].url, 'http://127.0.0.3:1400/xml');
    });
  });

  describe('topology', () => {
    it('populates zones and players from the topology notification', async () => {
      const { system, discover, topology } = setup();
      await discover();

      topology();

      assert.ok(system.zones.length > 0);
      for (const zone of system.zones) {
        assert.ok(zone.members.length > 0);
        for (const member of zone.members) {
          assert.ok(member instanceof Player);
        }
      }
      assert.equal(system.zones[0]?.id, 'RINCON_00000000000301400:66');
      assert.equal(system.getPlayer('TV Room')?.roomName, 'TV Room');
    });

    it('does not contain invisible units', async () => {
      const { system, discover, topology } = setup();
      await discover();
      topology();

      for (const zone of system.zones) {
        for (const member of zone.members) {
          assert.notEqual(member.roomName, 'BOOST');
        }
      }
      assert.equal(system.players.filter((player) => player.roomName === 'TV Room').length, 1);
    });

    it('flags players with a connected SUB', async () => {
      const { system, discover, topology } = setup();
      await discover();
      topology();

      assert.equal(system.getPlayer('TV Room')?.hasSub, true);
      assert.equal(system.getPlayer('Living Room')?.hasSub, true);
      assert.equal(system.getPlayer('Home Theatre')?.hasSub, true);
      assert.equal(system.getPlayer('Kitchen')?.hasSub, false);
    });

    it('creates every player once even when the topology repeats', async () => {
      const { discover, topology, createPlayer } = setup();
      await discover();

      topology();
      topology();

      assert.equal(createPlayer.mock.callCount(), 7);
    });

    it('links every member to its coordinator', async () => {
      const { system, discover, topology } = setup();
      await discover();
      topology();

      for (const zone of system.zones) {
        assert.ok(zone.coordinator instanceof Player);
        for (const member of zone.members) {
          assert.equal(member.coordinator.uuid, zone.uuid);
        }
      }
    });

    it('falls back to the first member when the coordinator is not a visible player', async () => {
      const { system, discover, listener, messages } = setup();
      await discover();

      listener().emit('topology', 'RINCON_X', [
        {
          $attrs: { coordinator: 'RINCON_INVISIBLE', id: 'RINCON_INVISIBLE:1' },
          zonegroupmember: [
            {
              uuid: 'RINCON_INVISIBLE',
              location: 'http://10.0.0.1:1400/x',
              zonename: 'Sub',
              invisible: '1',
            },
            { uuid: 'RINCON_VISIBLE', location: 'http://10.0.0.2:1400/x', zonename: 'Den' },
          ],
        },
      ]);

      assert.equal(system.zones[0]?.coordinator.roomName, 'Den');
      assert.equal(system.getPlayer('Den')?.coordinator.roomName, 'Den');
      assert.ok(messages().some((message) => message.includes('not a visible player')));
    });

    it('takes the coordinator from the group id when the attribute arrives empty', async () => {
      // Sonos reports Coordinator="" while a group is being formed; the id still names it.
      const { system, discover, listener, messages, entries } = setup();
      await discover();

      listener().emit('topology', 'RINCON_X', [
        {
          $attrs: { coordinator: '', id: 'RINCON_FAMILY:3630835724' },
          zonegroupmember: [
            { uuid: 'RINCON_RUFF', location: 'http://10.0.0.1:1400/x', zonename: 'Ruff Playroom' },
            { uuid: 'RINCON_FAMILY', location: 'http://10.0.0.2:1400/x', zonename: 'Family Room' },
          ],
        },
      ]);

      const zone = system.zones[0];
      assert.equal(zone?.coordinator.roomName, 'Family Room');
      assert.equal(zone?.uuid, 'RINCON_FAMILY', 'the zone carries the resolved coordinator uuid');
      assert.equal(system.getPlayer('Ruff Playroom')?.coordinator.roomName, 'Family Room');
      assert.equal(
        messages().some((message) => message.includes('not a visible player')),
        false,
        'recovering from the id is not a warning',
      );
      assert.ok(
        entries().some(
          (entry) =>
            entry.msg === 'group reported no coordinator, taking it from the group id' &&
            entry.level === 20,
        ),
      );
    });

    it('reads the coordinator uuid out of a group id', () => {
      assert.equal(coordinatorFromGroupId('RINCON_FAMILY:3630835724'), 'RINCON_FAMILY');
      assert.equal(coordinatorFromGroupId('RINCON_FAMILY'), 'RINCON_FAMILY');
      assert.equal(coordinatorFromGroupId(undefined), '');
    });

    it('looks players up by name (case-insensitively) and by uuid', async () => {
      const { system, discover, topology } = setup();
      await discover();
      topology();

      assert.equal(system.getPlayer('Office')?.roomName, 'Office');
      assert.equal(system.getPlayer('officE')?.roomName, 'Office');
      assert.equal(system.getPlayerByUUID('RINCON_20000000000001400')?.roomName, 'TV Room');
      assert.equal(system.getPlayer('Nope'), undefined);
    });

    it('emits topology-change with the zones', async () => {
      const { system, discover, topology } = setup();
      await discover();
      const event = once(system, 'topology-change');

      topology();

      const [zones] = await event;
      assert.equal(zones, system.zones);
    });

    it('disposes players that leave the system', async () => {
      const { system, discover, topology } = setup();
      await discover();
      topology();
      const office = system.getPlayer('Office');
      assert.ok(office);
      const dispose = mock.method(office, 'dispose');

      topology('topology_without_office.json');

      assert.equal(system.getPlayer('Office'), undefined);
      assert.equal(dispose.mock.callCount(), 1);
    });
  });

  describe('available services', () => {
    async function initialized() {
      const context = setup();
      context.soap.queueResponse(createReadStream(fixturePath('listavailableservices.xml')));
      await context.discover();
      const ready = once(context.system, 'initialized');
      context.topology();
      await ready;
      return context;
    }

    it('lists the services through a discovered player and emits initialized once', async () => {
      const { system, soap } = await initialized();

      assert.equal(soap.calls.length, 1);
      assert.equal(soap.calls[0]?.url, 'http://192.168.1.151:1400/MusicServices/Control');
      assert.equal(soap.calls[0]?.action, SOAP_ACTIONS.ListAvailableServices);
      assert.equal(system.getServiceId('Spotify'), 9);
      assert.equal(system.getServiceId('Apple Music'), 204);
      assert.equal(system.getServiceType('Spotify'), 2311);
      assert.equal(system.getServiceType('Apple Music'), 52231);
    });

    it('throws UnknownServiceError for unknown services', async () => {
      const { system } = await initialized();

      assert.throws(() => system.getServiceId('UNKNOWN SERVICE'), UnknownServiceError);
      assert.throws(() => system.getServiceType('UNKNOWN SERVICE'), UnknownServiceError);
    });

    it('logs and continues when the service list cannot be fetched', async () => {
      const { system, soap, discover, topology, messages } = setup();
      soap.queueFailure(new Error('player busy'));
      const initializedEvent = mock.fn();
      system.on('initialized', initializedEvent);
      await discover();

      topology();
      await flushPromises();

      assert.ok(messages().includes('could not list music services'));
      assert.equal(initializedEvent.mock.callCount(), 0);
      assert.deepEqual(system.availableServices, {});
    });
  });

  describe('players', () => {
    it('getAnyPlayer round-robins and is undefined before discovery', async () => {
      const { system, discover, topology } = setup();
      assert.equal(system.getAnyPlayer(), undefined);
      await discover();
      topology();

      const first = system.getAnyPlayer();
      const second = system.getAnyPlayer();

      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first, second);
    });

    it('delegates favorites, playlists and share index refresh to a player', async () => {
      const { system, soap, discover, topology } = setup();
      await discover();
      topology();
      await flushPromises();
      soap.calls.length = 0;
      soap.queueResponse(createReadStream(fixturePath('playlists.xml')));
      soap.queueResponse(createReadStream(fixturePath('playlists.xml')));

      const favorites = await system.getFavorites();
      const playlists = await system.getPlaylists();
      await system.refreshShareIndex();

      assert.equal(favorites.length, 2);
      assert.equal(playlists.length, 2);
      assert.deepEqual(soap.calls[0]?.values, { objectId: 'FV:2', startIndex: 0, limit: 0 });
      assert.deepEqual(soap.calls[1]?.values, { objectId: 'SQ:', startIndex: 0, limit: 0 });
      assert.equal(soap.calls[2]?.action, SOAP_ACTIONS.RefreshShareIndex);
    });

    it('rejects favorites before any player is known', async () => {
      const { system } = setup();

      await assert.rejects(system.getFavorites(), /No Sonos players/);
    });

    it('applies presets against itself', async () => {
      const { system, discover, topology } = setup();
      await discover();
      topology();
      const kitchen = system.getPlayer('Kitchen');
      assert.ok(kitchen);
      const play = mock.method(kitchen, 'play', () => Promise.resolve());
      const setVolume = mock.method(kitchen, 'setVolume', () => Promise.resolve());

      await system.applyPreset({ players: [{ roomName: 'Kitchen', volume: 7 }] });

      assert.equal(setVolume.mock.calls[0]?.arguments[0], 7);
      assert.equal(play.mock.callCount(), 1);
    });
  });

  describe('notification routing', () => {
    it('routes last-change and group-mute to the matching player', async () => {
      const { system, discover, topology, listener } = setup();
      await discover();
      topology();
      const kitchen = system.getPlayer('Kitchen');
      assert.ok(kitchen);
      const office = system.getPlayer('Office');
      assert.ok(office);

      listener().emit(
        'last-change',
        kitchen.uuid,
        readJsonFixture<LastChangeData>('renderingControlLastChange.json'),
      );
      listener().emit('group-mute', kitchen.uuid, '1');
      listener().emit('last-change', 'RINCON_UNKNOWN', {
        volume: [{ channel: 'Master', val: '3' }],
      });
      await flushPromises();

      assert.equal(kitchen.state.volume, 12);
      assert.equal(kitchen.groupState.mute, true);
      assert.equal(office.state.volume, 0);
    });

    it('re-emits queue-change with the player and list-change as-is', async () => {
      const { system, discover, topology, listener } = setup();
      await discover();
      topology();
      const queueChange = mock.fn();
      const listChange = mock.fn();
      system.on('queue-change', queueChange);
      system.on('list-change', listChange);

      listener().emit('queue-change', 'RINCON_00000000000101400');
      listener().emit('queue-change', 'RINCON_UNKNOWN');
      listener().emit('list-change', 'favorites');

      assert.equal(queueChange.mock.callCount(), 1);
      assert.equal((queueChange.mock.calls[0]?.arguments[0] as Player).roomName, 'Kitchen');
      assert.deepEqual(listChange.mock.calls[0]?.arguments, ['favorites']);
    });
  });

  describe('discovery hosts', () => {
    it('seeds discovery from the configured hosts even without SSDP replies', async () => {
      const { system, ssdp, http, subscribers } = setup({
        discoveryHosts: ['192.168.2.230', '192.168.2.231'],
        household: 'Sonos_configured',
      });

      system.start();
      await flushPromises();

      assert.equal(ssdp.start.mock.callCount(), 1, 'SSDP still runs alongside');
      assert.equal(http.mock.callCount(), 1, 'only the first host initializes the system');
      assert.equal(
        http.mock.calls[0]?.arguments[0].url,
        'http://192.168.2.230:1400/xml/device_description.xml',
      );
      assert.equal(subscribers[0]?.url, 'http://192.168.2.230:1400/ZoneGroupTopology/Event');
      assert.equal(ssdp.stop.mock.callCount(), 1);
    });

    it('retries the hosts after a failure with a delay', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const { system, http, messages } = setup({
          discoveryHosts: ['192.168.2.230'],
          httpFails: true,
        });

        system.start();
        mock.timers.tick(0);
        await flushPromises();
        assert.equal(http.mock.callCount(), 1);
        assert.ok(messages().includes('discovery failed, retrying'));

        mock.timers.tick(4999);
        await flushPromises();
        assert.equal(http.mock.callCount(), 1, 'not before the retry delay');
        mock.timers.tick(1);
        await flushPromises();
        assert.equal(http.mock.callCount(), 2);

        await system.dispose();
        mock.timers.tick(10_000);
        await flushPromises();
        assert.equal(http.mock.callCount(), 2, 'no retries after dispose');
      } finally {
        mock.timers.reset();
      }
    });
  });

  describe('dispose', () => {
    it('stops scanning, unsubscribes everything and ignores later discoveries', async () => {
      const { system, ssdp, discover, topology, listeners, subscribers, http } = setup();
      await discover();
      topology();
      const players = [...system.players];

      await system.dispose();
      ssdp.emit('found', FOUND);
      await flushPromises();

      assert.equal(ssdp.stop.mock.callCount(), 2);
      assert.equal(subscribers[0]?.dispose.mock.callCount(), 1);
      assert.equal(listeners[0]?.close.mock.callCount(), 1);
      assert.ok(players.length > 0);
      assert.equal(http.mock.callCount(), 1, 'no new discovery after dispose');
      assert.deepEqual(system.players, players, 'dispose leaves the last known topology readable');
    });
  });
});
