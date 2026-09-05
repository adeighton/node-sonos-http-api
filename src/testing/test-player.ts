import { mock } from 'node:test';
import type { Mock } from 'node:test';

import { Player } from '../discovery/player.ts';
import type { PlayerDeps } from '../discovery/player.ts';
import type { ZoneMemberData } from '../discovery/types.ts';
import { fakeSoapClient } from './fake-soap.ts';
import type { FakeSoapClient } from './fake-soap.ts';
import { FakeSystem } from './fake-system.ts';

export interface TestPlayerOptions {
  system?: FakeSystem;
  roomName?: string;
  uuid?: string;
  location?: string;
  channelmapset?: string;
  soap?: FakeSoapClient;
  artLookup?: PlayerDeps['artLookup'];
  notificationEndpoint?: string;
}

export interface FakeSubscriber {
  url: string;
  notificationUrl: string;
  dispose: Mock<() => Promise<void>>;
}

export interface TestPlayer {
  player: Player;
  system: FakeSystem;
  soap: FakeSoapClient;
  data: ZoneMemberData;
  subscribers: FakeSubscriber[];
  artLookup: PlayerDeps['artLookup'];
}

/** A real Player wired to fakes: a recording SOAP client, a FakeSystem and fake subscribers. */
export function createTestPlayer(options: TestPlayerOptions = {}): TestPlayer {
  const system = options.system ?? new FakeSystem();
  const soap = options.soap ?? fakeSoapClient();
  const subscribers: FakeSubscriber[] = [];
  const artLookup =
    options.artLookup ?? mock.fn((_uri: string) => Promise.reject(new Error('No such service')));

  const data: ZoneMemberData = {
    uuid: options.uuid ?? 'RINCON_00000000000001400',
    location: options.location ?? 'http://192.168.1.151:1400/xml/device_description.xml',
    zonename: options.roomName ?? 'Kitchen',
    icon: 'x-rincon-roomicon:kitchen',
    configuration: '1',
    softwareversion: '31.8-24090',
  };
  if (options.channelmapset !== undefined) {
    data.channelmapset = options.channelmapset;
  }

  const player = new Player(data, options.notificationEndpoint ?? 'http://127.0.0.2/', system, {
    soap,
    artLookup,
    createSubscriber: (url, notificationUrl) => {
      const subscriber: FakeSubscriber = {
        url,
        notificationUrl,
        dispose: mock.fn(() => Promise.resolve()),
      };
      subscribers.push(subscriber);
      return subscriber;
    },
  });

  return { player, system, soap, data, subscribers, artLookup };
}
