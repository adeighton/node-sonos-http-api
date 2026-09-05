import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { LIST_TYPE } from './player-state.ts';
import type { ListType } from './player-state.ts';
import type { LastChangeData, ZoneGroupData, ZoneMemberData } from './types.ts';
import { XML_ARRAYS, collectXmlTags, firstXmlTag, nodeText, parseXmlEvents } from './xml.ts';
import type { XmlNode } from './xml.ts';

export interface NotificationEvents {
  topology: [uuid: string, zoneGroups: ZoneGroupData[]];
  'last-change': [uuid: string, data: LastChangeData];
  'group-mute': [uuid: string, mute: string];
  'list-change': [type: ListType];
  'queue-change': [uuid: string];
}

/** The subset of node:http.Server used here, so tests can inject a fake. */
export interface NotificationServer {
  listen(port: number): unknown;
  on(event: 'listening', handler: () => void): unknown;
  on(event: 'error', handler: (error: NodeJS.ErrnoException) => void): unknown;
  close(callback?: (error?: Error) => void): unknown;
}

/** What the listener needs from an incoming request (node:http.IncomingMessage satisfies it). */
export interface NotificationRequest extends Readable {
  method?: string | undefined;
  headers: IncomingHttpHeaders;
}

/** What the listener needs from a response (node:http.ServerResponse satisfies it). */
export interface NotificationResponse {
  writeHead(statusCode: number): unknown;
  end(): unknown;
}

export type RequestHandler = (request: NotificationRequest, response: NotificationResponse) => void;

export interface NotificationListenerDeps {
  createServer?: (handler: RequestHandler) => NotificationServer;
  logger?: Logger;
}

export interface NotificationListenerOptions {
  /** First port to try; incremented while in use. Default 3500. */
  port?: number;
}

/** Turns the escaped ZoneGroupState XML into zone groups with attribute-only members. */
export async function parseTopology(text: string): Promise<ZoneGroupData[]> {
  const groups = await collectXmlTags(text, 'zonegroup', {
    preserveMarkup: XML_ARRAYS.NEVER,
    useArrays: XML_ARRAYS.SOMETIMES,
  });

  return groups.map((group) => {
    const raw = group.zonegroupmember;
    const toMember = (member: unknown): ZoneMemberData =>
      ((member as XmlNode).$attrs ?? member) as ZoneMemberData;
    const zonegroupmember = Array.isArray(raw) ? raw.map(toMember) : toMember(raw);

    return {
      $name: group.$name,
      $attrs: group.$attrs as ZoneGroupData['$attrs'],
      zonegroupmember,
    };
  });
}

/** Extracts the `<InstanceID>` node from an escaped LastChange event. */
export async function parseLastChange(text: string): Promise<LastChangeData | undefined> {
  return firstXmlTag(text, 'instanceid');
}

/**
 * A local HTTP server that receives UPnP NOTIFY callbacks from the players and re-emits them
 * as typed events keyed by the player uuid found in the SID header.
 */
export class NotificationListener extends EventEmitter<NotificationEvents> {
  readonly #localEndpoint: string;
  readonly #createServer: (handler: RequestHandler) => NotificationServer;
  readonly #logger: Logger;
  readonly #lastUpdate = new Map<ListType, string>();
  #port: number;
  #server: NotificationServer | undefined;

  constructor(
    localEndpoint: string,
    deps: NotificationListenerDeps = {},
    options: NotificationListenerOptions = {},
  ) {
    super();
    this.#localEndpoint = localEndpoint;
    this.#createServer = deps.createServer ?? ((handler) => http.createServer(handler));
    this.#logger = deps.logger ?? silentLogger;
    this.#port = options.port ?? 3500;
  }

  /** The callback URL players are told to NOTIFY. */
  get endpoint(): string {
    return `http://${this.#localEndpoint}:${this.#port}/`;
  }

  get port(): number {
    return this.#port;
  }

  /** Starts listening, moving to the next port while the current one is in use. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = this.#createServer((request, response) =>
        this.handleNotification(request, response),
      );
      this.#server = server;

      server.on('listening', () => {
        this.#logger.debug({ port: this.#port }, 'notification listener ready');
        resolve(this.#port);
      });
      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          this.#port += 1;
          server.listen(this.#port);
          return;
        }

        reject(error);
      });

      server.listen(this.#port);
    });
  }

  close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) {
      return Promise.resolve();
    }

    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** Handles one NOTIFY request; public so tests can drive it without a real socket. */
  handleNotification(request: NotificationRequest, response: NotificationResponse): void {
    const sid = request.headers.sid;
    const match = typeof sid === 'string' ? /uuid:(.+)_sub/.exec(sid) : null;
    if (request.method !== 'NOTIFY' || !match) {
      request.resume();
      response.writeHead(200);
      response.end();
      return;
    }

    const uuid = match[1] as string;
    const pending: Promise<void>[] = [];

    parseXmlEvents(
      request,
      {
        zonegroupstate: (property) => {
          const text = nodeText(property) ?? '';
          this.#logger.trace({ uuid }, 'received topology notification');
          pending.push(
            parseTopology(text).then((zoneGroups) => {
              this.emit('topology', uuid, zoneGroups);
            }),
          );
        },
        lastchange: (property) => {
          const text = nodeText(property) ?? '';
          pending.push(
            parseLastChange(text).then((lastChange) => {
              if (lastChange) {
                this.emit('last-change', uuid, lastChange);
              }
            }),
          );
        },
        groupmute: (property) => {
          this.emit('group-mute', uuid, nodeText(property) ?? '');
        },
        savedqueuesupdateid: (property) => {
          this.#emitListChangeOnce(LIST_TYPE.SAVED_QUEUES, nodeText(property) ?? '');
        },
        favoritesupdateid: (property) => {
          this.#emitListChangeOnce(LIST_TYPE.FAVORITES, nodeText(property) ?? '');
        },
        containerupdateids: (property) => {
          const text = nodeText(property) ?? '';
          if (text.includes('Q:0')) {
            this.emit('queue-change', uuid);
          }

          if (text.includes('AI:')) {
            this.emit('list-change', LIST_TYPE.INPUTS);
          }
        },
      },
      { useArrays: XML_ARRAYS.NEVER },
    )
      .then(() => Promise.all(pending))
      .then(() => {
        response.writeHead(200);
        response.end();
      })
      .catch((error: unknown) => {
        this.#logger.warn({ err: error, uuid }, 'failed to parse notification');
        response.writeHead(500);
        response.end();
      });
  }

  #emitListChangeOnce(type: ListType, updateId: string): void {
    if (this.#lastUpdate.get(type) === updateId) {
      return;
    }

    this.#lastUpdate.set(type, updateId);
    this.emit('list-change', type);
  }
}
