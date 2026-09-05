import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';

export interface SsdpFound {
  household: string | undefined;
  location: string;
  ip: string;
}

export interface SsdpEvents {
  found: [SsdpFound];
}

/** What the scanner needs from a UDP socket (node:dgram.Socket satisfies it). */
export interface SsdpSocket {
  bind(port: number, address: string, callback: () => void): unknown;
  send(message: Buffer, offset: number, length: number, port: number, address: string): unknown;
  close(): unknown;
  on(event: 'error', handler: (error: NodeJS.ErrnoException) => void): unknown;
  setMulticastTTL(ttl: number): unknown;
  setBroadcast(flag: boolean): unknown;
}

export interface SsdpMessageInfo {
  address: string;
}

export interface SsdpDgram {
  createSocket(
    options: { type: 'udp4'; reuseAddr: boolean },
    onMessage: (message: Buffer, rinfo: SsdpMessageInfo) => void,
  ): SsdpSocket;
}

export interface SsdpNetworkInterface {
  internal: boolean;
  family: string | number;
  address: string;
}

export interface SsdpOs {
  networkInterfaces(): Record<string, SsdpNetworkInterface[] | undefined>;
}

export interface SsdpDeps {
  dgram?: SsdpDgram;
  os?: SsdpOs;
  logger?: Logger;
}

export interface SsdpOptions {
  /** Local UDP port for M-SEARCH replies; falls back to an ephemeral port if busy. Default 1905. */
  port?: number;
  /** How often to repeat the M-SEARCH. Default 1000 ms. */
  scanIntervalMs?: number;
  /** How often to re-create the socket on the next local interface. Default 5000 ms. */
  socketCycleMs?: number;
}

const SONOS_PLAYER_UPNP_URN = 'urn:schemas-upnp-org:device:ZonePlayer:1';
const SSDP_PORT = 1900;
const REMOTE_ENDPOINTS = ['239.255.255.250', '255.255.255.255'];

const PLAYER_SEARCH = Buffer.from(
  [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:reservedSSDPport',
    'MAN: ssdp:discover',
    'MX: 1',
    `ST: ${SONOS_PLAYER_UPNP_URN}`,
  ].join('\r\n'),
);

function findLocalEndpoints(osModule: SsdpOs): string[] {
  const endpoints = ['0.0.0.0'];
  for (const addresses of Object.values(osModule.networkInterfaces())) {
    for (const info of addresses ?? []) {
      // `family` is the string 'IPv4' on current Node, the number 4 on a few 18.x releases.
      const isIpv4 = info.family === 'IPv4' || info.family === 4;
      if (!info.internal && isIpv4) {
        endpoints.push(info.address);
      }
    }
  }

  return endpoints;
}

export function parseSsdpResponse(buffer: Buffer, rinfo: SsdpMessageInfo): SsdpFound | undefined {
  const response = buffer.toString('ascii');
  if (!response.includes(SONOS_PLAYER_UPNP_URN)) {
    // Badly behaved non-Sonos devices answer every M-SEARCH.
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const line of response.split('\r\n')) {
    const match = /^([^:]+): (.+)/i.exec(line);
    if (match) {
      headers[match[1] as string] = match[2] as string;
    }
  }

  const location = headers.LOCATION;
  if (location === undefined) {
    return undefined;
  }

  return { household: headers['X-RINCON-HOUSEHOLD'], location, ip: rinfo.address };
}

/**
 * Finds Sonos players by sending SSDP M-SEARCH requests, alternating between multicast and
 * broadcast and cycling through the local interfaces, until `stop()` is called.
 */
export class Ssdp extends EventEmitter<SsdpEvents> {
  readonly #dgram: SsdpDgram;
  readonly #logger: Logger;
  readonly #localEndpoints: string[];
  readonly #scanIntervalMs: number;
  readonly #socketCycleMs: number;
  #port: number;
  #socket: SsdpSocket | undefined;
  #scanTimer: NodeJS.Timeout | undefined;
  #cycleTimer: NodeJS.Timeout | undefined;
  #remoteEndpointIndex = 0;
  #localEndpointIndex = 0;

  constructor(deps: SsdpDeps = {}, options: SsdpOptions = {}) {
    super();
    this.#dgram = deps.dgram ?? dgram;
    this.#logger = deps.logger ?? silentLogger;
    this.#localEndpoints = findLocalEndpoints(deps.os ?? os);
    this.#port = options.port ?? 1905;
    this.#scanIntervalMs = options.scanIntervalMs ?? 1000;
    this.#socketCycleMs = options.socketCycleMs ?? 5000;
  }

  start(): void {
    this.stop();
    this.#createSocket(() => this.#sendScan());
    this.#cycleTimer = setInterval(() => this.#createSocket(), this.#socketCycleMs);
  }

  stop(): void {
    clearInterval(this.#cycleTimer);
    clearTimeout(this.#scanTimer);
    this.#cycleTimer = undefined;
    this.#scanTimer = undefined;
    this.#closeSocket();
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) {
      return;
    }

    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  #createSocket(onBound?: () => void): void {
    this.#closeSocket();

    const socket = this.#dgram.createSocket({ type: 'udp4', reuseAddr: true }, (buffer, rinfo) =>
      this.#receive(buffer, rinfo),
    );
    this.#socket = socket;

    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && this.#port !== 0) {
        this.#logger.warn(
          { port: this.#port },
          'SSDP port is in use, falling back to an ephemeral port',
        );
        this.#port = 0;
        this.#createSocket(onBound);
        return;
      }

      this.#logger.warn({ err: error }, 'SSDP socket error');
    });

    const endpoint =
      this.#localEndpoints[this.#localEndpointIndex++ % this.#localEndpoints.length] ?? '0.0.0.0';
    socket.bind(this.#port, endpoint, () => {
      // TTL 2 allows discovery through one router hop in a VLAN environment.
      socket.setMulticastTTL(2);
      // Needed to send to 255.255.255.255.
      socket.setBroadcast(true);
      onBound?.();
    });
  }

  #sendScan(): void {
    const socket = this.#socket;
    if (!socket) {
      return;
    }

    this.#logger.trace('sending M-SEARCH');
    const remoteEndpoint =
      REMOTE_ENDPOINTS[this.#remoteEndpointIndex++ % REMOTE_ENDPOINTS.length] ?? '239.255.255.250';
    socket.send(PLAYER_SEARCH, 0, PLAYER_SEARCH.length, SSDP_PORT, remoteEndpoint);
    this.#scanTimer = setTimeout(() => this.#sendScan(), this.#scanIntervalMs);
  }

  #receive(buffer: Buffer, rinfo: SsdpMessageInfo): void {
    const found = parseSsdpResponse(buffer, rinfo);
    if (found) {
      this.emit('found', found);
    }
  }
}
