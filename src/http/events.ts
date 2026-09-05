import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';

/** One connected `/events` subscriber (the app adapts Hono's SSE stream to this). */
export interface SseClient {
  writeEvent(data: string): Promise<void> | void;
  writeComment(text: string): Promise<void> | void;
}

export interface EventHubOptions {
  /** Interval of the `: keep-alive` comment that detects half-open connections. Default 30 s. */
  keepAliveMs?: number;
  logger?: Logger;
}

/** Fans system events out to every server-sent-events client. */
export class EventHub {
  readonly #clients = new Set<SseClient>();
  readonly #keepAliveMs: number;
  readonly #logger: Logger;
  #keepAliveTimer: NodeJS.Timeout | undefined;

  constructor(options: EventHubOptions = {}) {
    this.#keepAliveMs = options.keepAliveMs ?? 30_000;
    this.#logger = options.logger ?? silentLogger;
  }

  get size(): number {
    return this.#clients.size;
  }

  add(client: SseClient): void {
    this.#clients.add(client);
    this.#logger.debug({ clients: this.#clients.size }, 'event client connected');
    if (!this.#keepAliveTimer) {
      this.#keepAliveTimer = setInterval(() => this.#keepAlive(), this.#keepAliveMs);
      this.#keepAliveTimer.unref();
    }
  }

  remove(client: SseClient): void {
    if (!this.#clients.delete(client)) {
      return;
    }

    this.#logger.debug({ clients: this.#clients.size }, 'event client disconnected');
    if (this.#clients.size === 0) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = undefined;
    }
  }

  /** Sends one event (a JSON document) to every client; clients that fail to receive are dropped. */
  broadcast(data: string): void {
    for (const client of this.#clients) {
      this.#deliver(client, () => client.writeEvent(data));
    }
  }

  close(): void {
    clearInterval(this.#keepAliveTimer);
    this.#keepAliveTimer = undefined;
    this.#clients.clear();
  }

  #keepAlive(): void {
    for (const client of this.#clients) {
      this.#deliver(client, () => client.writeComment('keep-alive'));
    }
  }

  #deliver(client: SseClient, write: () => Promise<void> | void): void {
    try {
      const result = write();
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.#drop(client, error));
      }
    } catch (error) {
      this.#drop(client, error);
    }
  }

  #drop(client: SseClient, error: unknown): void {
    this.#logger.debug({ err: error }, 'dropping event client after a failed write');
    this.remove(client);
  }
}
