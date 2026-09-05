import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { Ssdp, parseSsdpResponse } from './ssdp.ts';
import type { SsdpDgram, SsdpMessageInfo, SsdpOs, SsdpSocket } from './ssdp.ts';

type MessageHandler = (message: Buffer, rinfo: SsdpMessageInfo) => void;
type ErrorHandler = (error: NodeJS.ErrnoException) => void;

function fakeSocket() {
  let errorHandler: ErrorHandler | undefined;
  const socket = {
    boundCallback: undefined as (() => void) | undefined,
    bind: mock.fn((_port: number, _address: string, callback: () => void) => {
      socket.boundCallback = callback;
    }),
    send: mock.fn(
      (_message: Buffer, _offset: number, _length: number, _port: number, _address: string) =>
        undefined,
    ),
    close: mock.fn(() => undefined),
    on: mock.fn((_event: 'error', handler: ErrorHandler) => {
      errorHandler = handler;
    }),
    setMulticastTTL: mock.fn((_ttl: number) => undefined),
    setBroadcast: mock.fn((_flag: boolean) => undefined),
    emitError(error: NodeJS.ErrnoException) {
      errorHandler?.(error);
    },
  };
  return socket;
}

function fakeDgram() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  let onMessage: MessageHandler | undefined;

  const createSocket = mock.fn(
    (_options: { type: 'udp4'; reuseAddr: boolean }, handler: MessageHandler): SsdpSocket => {
      onMessage = handler;
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
  );
  const dgram: SsdpDgram = { createSocket };

  return {
    dgram,
    createSocket,
    sockets,
    receive(message: Buffer, address: string) {
      assert.ok(onMessage, 'no socket created yet');
      onMessage(message, { address });
    },
  };
}

const os: SsdpOs = {
  networkInterfaces: () => ({
    eth0: [{ internal: false, family: 'IPv4', address: '10.0.0.1' }],
    lo0: [{ internal: true, family: 'IPv4', address: '127.0.0.1' }],
    wifi: [{ internal: false, family: 'IPv6', address: 'fe80::1' }],
    legacy: [{ internal: false, family: 4, address: '10.0.0.2' }],
    missing: undefined,
  }),
};

function busyError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('bind EADDRINUSE');
  error.code = 'EADDRINUSE';
  return error;
}

describe('Ssdp', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('creates a listening UDP socket on port 1905 bound to all interfaces first', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });

    ssdp.start();

    assert.equal(fake.createSocket.mock.callCount(), 1);
    const socket = fake.sockets[0];
    assert.equal(socket?.bind.mock.callCount(), 1);
    assert.equal(socket?.bind.mock.calls[0]?.arguments[0], 1905);
    assert.equal(socket?.bind.mock.calls[0]?.arguments[1], '0.0.0.0');

    socket?.boundCallback?.();
    assert.deepEqual(socket?.setMulticastTTL.mock.calls[0]?.arguments, [2]);
    assert.deepEqual(socket?.setBroadcast.mock.calls[0]?.arguments, [true]);
    ssdp.stop();
  });

  it('sends M-SEARCH to the multicast address once bound', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });

    ssdp.start();
    fake.sockets[0]?.boundCallback?.();

    const send = fake.sockets[0]?.send;
    assert.equal(send?.mock.callCount(), 1);
    const call = send?.mock.calls[0];
    assert.ok(call);
    const [payload, , , port, address] = call.arguments;
    assert.ok(payload.toString().includes('M-SEARCH'));
    assert.ok(payload.toString().includes('urn:schemas-upnp-org:device:ZonePlayer:1'));
    assert.equal(port, 1900);
    assert.equal(address, '239.255.255.250');
    ssdp.stop();
  });

  it('repeats the M-SEARCH periodically, alternating with broadcast', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });

    ssdp.start();
    fake.sockets[0]?.boundCallback?.();
    mock.timers.tick(1000);

    const send = fake.sockets[0]?.send;
    assert.equal(send?.mock.callCount(), 2);
    assert.equal(send?.mock.calls[1]?.arguments[4], '255.255.255.255');
    ssdp.stop();
  });

  it('cycles through the IPv4 interfaces after the socket cycle interval', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });

    ssdp.start();
    fake.sockets[0]?.boundCallback?.();
    mock.timers.tick(5000);
    mock.timers.tick(5000);
    mock.timers.tick(5000);

    assert.equal(fake.createSocket.mock.callCount(), 4);
    assert.equal(fake.sockets[0]?.close.mock.callCount(), 1, 'previous socket is closed');
    assert.equal(fake.sockets[1]?.bind.mock.calls[0]?.arguments[1], '10.0.0.1');
    assert.equal(fake.sockets[2]?.bind.mock.calls[0]?.arguments[1], '10.0.0.2');
    assert.equal(fake.sockets[3]?.bind.mock.calls[0]?.arguments[1], '0.0.0.0');
    ssdp.stop();
  });

  it('emits found for a Sonos response and ignores other devices', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });
    const found = mock.fn();
    ssdp.on('found', found);
    ssdp.start();

    fake.receive(
      Buffer.from(
        [
          'LOCATION: http://10.0.0.1:1400/device_descriptor.xml',
          'X-RINCON-HOUSEHOLD: Sonos_123456789abcdef',
          'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
        ].join('\r\n'),
      ),
      '127.0.0.1',
    );
    fake.receive(Buffer.from('LOCATION: http://printer/\r\nST: urn:other'), '10.0.0.9');
    fake.receive(Buffer.from('ST: urn:schemas-upnp-org:device:ZonePlayer:1'), '10.0.0.9');

    assert.equal(found.mock.callCount(), 1);
    assert.deepEqual(found.mock.calls[0]?.arguments[0], {
      household: 'Sonos_123456789abcdef',
      ip: '127.0.0.1',
      location: 'http://10.0.0.1:1400/device_descriptor.xml',
    });
    ssdp.stop();
  });

  it('closes the socket and clears timers when stopped', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });

    ssdp.start();
    fake.sockets[0]?.boundCallback?.();
    ssdp.stop();
    mock.timers.tick(10_000);

    assert.equal(fake.sockets[0]?.close.mock.callCount(), 1);
    assert.equal(fake.createSocket.mock.callCount(), 1, 'no more sockets after stop');
    assert.equal(fake.sockets[0]?.send.mock.callCount(), 1, 'no more scans after stop');
  });

  it('falls back to an ephemeral port when 1905 is in use', () => {
    const fake = fakeDgram();
    const { logger, messages } = captureLogs();
    const ssdp = new Ssdp({ dgram: fake.dgram, os, logger });

    ssdp.start();
    fake.sockets[0]?.emitError(busyError());

    assert.equal(fake.createSocket.mock.callCount(), 2);
    assert.equal(fake.sockets[1]?.bind.mock.calls[0]?.arguments[0], 0);
    assert.ok(messages().some((message) => message.includes('ephemeral')));

    // A second EADDRINUSE on the ephemeral socket is only logged, never loops.
    fake.sockets[1]?.emitError(busyError());
    assert.equal(fake.createSocket.mock.callCount(), 2);
    ssdp.stop();
  });

  it('logs other socket errors without throwing', () => {
    const fake = fakeDgram();
    const { logger, entries } = captureLogs();
    const ssdp = new Ssdp({ dgram: fake.dgram, os, logger });

    ssdp.start();
    assert.doesNotThrow(() => fake.sockets[0]?.emitError(new Error('EPERM')));
    assert.ok(entries().some((entry) => entry.msg === 'SSDP socket error'));
    ssdp.stop();
  });

  it('survives a socket whose close() throws', () => {
    const fake = fakeDgram();
    const ssdp = new Ssdp({ dgram: fake.dgram, os });

    ssdp.start();
    fake.sockets[0]?.close.mock.mockImplementation(() => {
      throw new Error('Not running');
    });

    assert.doesNotThrow(() => ssdp.stop());
  });
});

describe('parseSsdpResponse', () => {
  it('requires a LOCATION header', () => {
    assert.equal(
      parseSsdpResponse(Buffer.from('ST: urn:schemas-upnp-org:device:ZonePlayer:1'), {
        address: '1.2.3.4',
      }),
      undefined,
    );
  });
});
