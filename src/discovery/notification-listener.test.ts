import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it, mock } from 'node:test';

import { fixturePath } from '../testing/fixtures.ts';
import { NotificationListener, parseLastChange, parseTopology } from './notification-listener.ts';
import type {
  NotificationRequest,
  NotificationServer,
  RequestHandler,
} from './notification-listener.ts';
import type { ChannelValueNode } from './types.ts';
import { asArray } from './xml.ts';

type ServerEventHandler = (error: NodeJS.ErrnoException) => void;

function fakeServer() {
  const handlers = new Map<string, ServerEventHandler>();
  let requestHandler: RequestHandler | undefined;

  const server = {
    listen: mock.fn((_port: number) => undefined),
    on: mock.fn((event: string, handler: ServerEventHandler) => {
      handlers.set(event, handler);
    }),
    close: mock.fn((callback?: (error?: Error) => void) => callback?.()),
  };

  const createServer = mock.fn((handler: RequestHandler): NotificationServer => {
    requestHandler = handler;
    return server;
  });

  return {
    createServer,
    server,
    emitListening() {
      handlers.get('listening')?.(new Error('unused'));
    },
    emitError(error: NodeJS.ErrnoException) {
      handlers.get('error')?.(error);
    },
    handler(): RequestHandler {
      assert.ok(requestHandler, 'server not created');
      return requestHandler;
    },
  };
}

function notifyRequest(
  fixture: string,
  sid = 'uuid:RINCON_12345678900001400_sub',
): NotificationRequest {
  return Object.assign(createReadStream(fixturePath(fixture)), {
    method: 'NOTIFY',
    headers: { sid },
  });
}

function inlineRequest(body: string, method = 'NOTIFY', sid?: string): NotificationRequest {
  return Object.assign(Readable.from([body]), {
    method,
    headers: sid === undefined ? {} : { sid },
  });
}

function fakeResponse() {
  const response = {
    writeHead: mock.fn((_statusCode: number) => undefined),
    end: mock.fn(() => undefined),
  };
  return {
    response,
    ended: () =>
      new Promise<number | undefined>((resolve) => {
        const check = (): void => {
          if (response.end.mock.callCount() > 0) {
            resolve(response.writeHead.mock.calls[0]?.arguments[0]);
            return;
          }

          setImmediate(check);
        };
        check();
      }),
  };
}

function busyError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('in use');
  error.code = 'EADDRINUSE';
  return error;
}

describe('NotificationListener', () => {
  it('listens on the first free port starting at 3500 and exposes the callback endpoint', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });

    const listening = listener.listen();
    assert.equal(fake.createServer.mock.callCount(), 1);
    assert.equal(fake.server.listen.mock.calls[0]?.arguments[0], 3500);

    fake.emitError(busyError());
    assert.equal(fake.server.listen.mock.calls[1]?.arguments[0], 3501);

    fake.emitListening();
    assert.equal(await listening, 3501);
    assert.equal(listener.port, 3501);
    assert.equal(listener.endpoint, 'http://127.0.0.2:3501/');

    await listener.close();
    assert.equal(fake.server.close.mock.callCount(), 1);
    await listener.close();
    assert.equal(fake.server.close.mock.callCount(), 1, 'closing twice is a no-op');
  });

  it('rejects listen() on other server errors', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });

    const listening = listener.listen();
    fake.emitError(new Error('EACCES'));

    await assert.rejects(listening, /EACCES/);
  });

  it('emits topology on ZoneGroupState', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const topology = once(listener, 'topology');

    fake.handler()(notifyRequest('zonegroupstate_with_satellites.xml'), fakeResponse().response);

    const [uuid, zoneGroups] = await topology;
    assert.equal(uuid, 'RINCON_12345678900001400');
    assert.ok(zoneGroups.length > 0);
    assert.ok(zoneGroups[0]?.$attrs.coordinator);
  });

  it('emits last-change for AVTransport events and answers 200', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const lastChange = once(listener, 'last-change');
    const { response, ended } = fakeResponse();

    fake.handler()(notifyRequest('avtransportlastchange.xml'), response);

    const [uuid, data] = await lastChange;
    assert.equal(uuid, 'RINCON_12345678900001400');
    assert.equal(data.transportstate?.val, 'PLAYING');
    assert.equal(
      (data.currenttrackuri as { val: string }).val,
      'x-sonos-spotify:spotify%3atrack%3a5qAFqkXoQd2RfjZ2j1ay0w?sid=9&flags=8224&sn=9',
    );
    assert.equal(await ended(), 200);
  });

  it('emits last-change for RenderingControl events with per-channel volumes', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const lastChange = once(listener, 'last-change');

    fake.handler()(notifyRequest('renderingcontrollastchange.xml'), fakeResponse().response);

    const [, data] = await lastChange;
    const master = asArray(data.volume as ChannelValueNode[]).find((x) => x.channel === 'Master');
    assert.equal(master?.val, '12');
  });

  it('emits last-change for SUB events', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const lastChange = once(listener, 'last-change');

    fake.handler()(notifyRequest('sublastchange.xml'), fakeResponse().response);

    const [, data] = await lastChange;
    assert.equal(data.subgain?.val, '-3');
    assert.equal(data.subcrossover?.val, '90');
    assert.equal(data.subenabled?.val, '1');
    assert.equal(data.subpolarity?.val, '0');
  });

  it('emits queue-change for queue container updates', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const queueChange = once(listener, 'queue-change');

    fake.handler()(notifyRequest('queuechange.xml'), fakeResponse().response);

    assert.deepEqual(await queueChange, ['RINCON_12345678900001400']);
  });

  it('emits list-change for favorites once per update id', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const listChange = mock.fn();
    listener.on('list-change', listChange);

    const first = fakeResponse();
    fake.handler()(notifyRequest('favoritechange.xml'), first.response);
    await first.ended();
    const second = fakeResponse();
    fake.handler()(notifyRequest('favoritechange.xml'), second.response);
    await second.ended();

    assert.equal(listChange.mock.callCount(), 1);
    assert.deepEqual(listChange.mock.calls[0]?.arguments, ['favorites']);
  });

  it('emits group-mute, saved-queue and inputs list changes from inline notifications', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const groupMute = mock.fn();
    const listChange = mock.fn();
    listener.on('group-mute', groupMute);
    listener.on('list-change', listChange);

    const body =
      '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><GroupMute>1</GroupMute></e:property><e:property><ContainerUpdateIDs>AI:,7</ContainerUpdateIDs></e:property><e:property><SavedQueuesUpdateID>RINCON_1,3</SavedQueuesUpdateID></e:property></e:propertyset>';
    const { response, ended } = fakeResponse();

    fake.handler()(inlineRequest(body, 'NOTIFY', 'uuid:RINCON_1_sub'), response);
    await ended();

    assert.deepEqual(groupMute.mock.calls[0]?.arguments, ['RINCON_1', '1']);
    assert.deepEqual(
      listChange.mock.calls.map((call) => call.arguments[0]),
      ['inputs', 'saved-queues'],
    );
  });

  it('answers non-NOTIFY requests and requests without a SID with 200 and ignores them', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();
    const events = mock.fn();
    listener.on('last-change', events);

    const get = fakeResponse();
    fake.handler()(inlineRequest('', 'GET'), get.response);
    assert.equal(await get.ended(), 200);

    const noSid = fakeResponse();
    fake.handler()(inlineRequest('<x/>', 'NOTIFY'), noSid.response);
    assert.equal(await noSid.ended(), 200);

    assert.equal(events.mock.callCount(), 0);
  });

  it('answers 500 and logs when the body stream fails', async () => {
    const fake = fakeServer();
    const listener = new NotificationListener('127.0.0.2', { createServer: fake.createServer });
    void listener.listen();

    const failing: NotificationRequest = Object.assign(
      new Readable({
        read() {
          this.destroy(new Error('reset'));
        },
      }),
      { method: 'NOTIFY', headers: { sid: 'uuid:RINCON_1_sub' } },
    );
    const { response, ended } = fakeResponse();
    fake.handler()(failing, response);

    assert.equal(await ended(), 500);
  });
});

describe('parseTopology / parseLastChange', () => {
  it('returns attribute-only members for single and multiple member groups', async () => {
    const text =
      '<ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"><ZoneGroupMember UUID="RINCON_A" Location="http://a" ZoneName="One"/></ZoneGroup><ZoneGroup Coordinator="RINCON_B" ID="RINCON_B:2"><ZoneGroupMember UUID="RINCON_B" Location="http://b" ZoneName="Two"/><ZoneGroupMember UUID="RINCON_C" Location="http://c" ZoneName="Three" Invisible="1"/></ZoneGroup></ZoneGroups>';
    const groups = await parseTopology(text);

    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0]?.$attrs, { coordinator: 'RINCON_A', id: 'RINCON_A:1' });
    assert.deepEqual(groups[0]?.zonegroupmember, {
      uuid: 'RINCON_A',
      location: 'http://a',
      zonename: 'One',
    });
    assert.ok(Array.isArray(groups[1]?.zonegroupmember));
    assert.equal((groups[1]?.zonegroupmember as unknown[]).length, 2);
  });

  it('parseLastChange returns undefined when there is no InstanceID', async () => {
    assert.equal(await parseLastChange('<Event/>'), undefined);
  });
});
