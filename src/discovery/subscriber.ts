import { EventEmitter } from 'node:events';

import type { StreamHttpClient } from './http.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';

export interface SubscriberEvents {
  dead: [string];
}

export interface SubscriberDeps {
  http: StreamHttpClient;
  logger?: Logger;
}

export interface SubscriberOptions {
  /** UPnP subscription lifetime in seconds; renewed at half of it. Default 600. */
  subscriptionIntervalSeconds?: number;
  /** Delay before retrying a failed (re)subscription. Default 5000 ms. */
  retryIntervalMs?: number;
}

const DEFAULT_SUBSCRIPTION_INTERVAL_SECONDS = 600;
const DEFAULT_RETRY_INTERVAL_MS = 5000;
const RETRIES_BEFORE_CONSIDERED_DEAD = 5;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Keeps one UPnP event subscription alive: SUBSCRIBE, renew before it expires, retry on failure,
 * emit `dead` after too many consecutive failures, UNSUBSCRIBE on dispose.
 */
export class Subscriber extends EventEmitter<SubscriberEvents> {
  readonly #subscribeUrl: string;
  readonly #notificationUrl: string;
  readonly #http: StreamHttpClient;
  readonly #logger: Logger;
  readonly #subscriptionIntervalSeconds: number;
  readonly #retryIntervalMs: number;
  #sid: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #errorCount = 0;
  #disposed = false;

  constructor(
    subscribeUrl: string,
    notificationUrl: string,
    deps: SubscriberDeps,
    options: SubscriberOptions = {},
  ) {
    super();
    this.#subscribeUrl = subscribeUrl;
    this.#notificationUrl = notificationUrl;
    this.#http = deps.http;
    this.#logger = deps.logger ?? silentLogger;
    this.#subscriptionIntervalSeconds =
      options.subscriptionIntervalSeconds ?? DEFAULT_SUBSCRIPTION_INTERVAL_SECONDS;
    this.#retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    void this.#subscribe();
  }

  get sid(): string | undefined {
    return this.#sid;
  }

  /** Stops renewing and tells the player to drop the subscription. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;

    const sid = this.#sid;
    if (sid === undefined) {
      return;
    }

    this.#sid = undefined;
    try {
      const response = await this.#http({
        headers: { SID: sid },
        url: this.#subscribeUrl,
        method: 'UNSUBSCRIBE',
        type: 'stream',
      });
      response.stream.resume();
      this.#logger.trace({ url: this.#subscribeUrl }, 'unsubscribed');
    } catch (error) {
      this.#logger.warn({ err: error, url: this.#subscribeUrl, sid }, 'unsubscribe failed');
    }
  }

  async #subscribe(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    clearTimeout(this.#timer);
    const headers: Record<string, string> = {
      TIMEOUT: `Second-${this.#subscriptionIntervalSeconds}`,
    };
    if (this.#sid !== undefined) {
      headers.SID = this.#sid;
    } else {
      headers.CALLBACK = `<${this.#notificationUrl}>`;
      headers.NT = 'upnp:event';
    }

    try {
      const response = await this.#http({
        headers,
        url: this.#subscribeUrl,
        method: 'SUBSCRIBE',
        type: 'stream',
      });
      response.stream.resume();
      if (this.#disposed) {
        return;
      }

      this.#sid = firstHeader(response.headers.sid);
      this.#errorCount = 0;
      this.#timer = setTimeout(
        () => void this.#subscribe(),
        this.#subscriptionIntervalSeconds * 500,
      );
    } catch (error) {
      if (this.#disposed) {
        return;
      }

      this.#logger.warn(
        { err: error, url: this.#subscribeUrl, sid: this.#sid },
        'subscribe failed, retrying',
      );
      this.#sid = undefined;
      this.#errorCount += 1;
      this.#timer = setTimeout(() => void this.#subscribe(), this.#retryIntervalMs);
      if (this.#errorCount === RETRIES_BEFORE_CONSIDERED_DEAD) {
        this.emit('dead', `Endpoint ${this.#subscribeUrl} has probably died`);
      }
    }
  }
}
