import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { ServiceUnavailableError } from '../http/errors.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { AnnouncementRunner } from './runner.ts';
import type {
  AnnounceSystem,
  AnnouncementHandle,
  AnnouncementSpec,
  AnnouncementTransition,
} from './types.ts';

export interface SchedulerOptions {
  system: AnnounceSystem;
  logger?: Logger | undefined;
  /** Announcements allowed to wait behind the current one; more are refused with 503. */
  maxQueued?: number | undefined;
  /** How long to wait for the players to regroup before playing anyway. Default 10 s. */
  topologyTimeoutMs?: number | undefined;
  /** How long a restore waits for the topology to show the groups back. Default 3 s. */
  restoreVerifyMs?: number | undefined;
}

export interface SchedulerEvents {
  transition: [AnnouncementTransition];
}

/** What a caller that is refused should wait before trying again, in seconds. */
const RETRY_AFTER_SECONDS = '10';

/**
 * Plays announcements one at a time, in the order they arrive, so their backups never capture
 * each other's clips. Every state change is published as a `transition` event.
 */
export class AnnouncementScheduler extends EventEmitter<SchedulerEvents> {
  readonly #options: Required<Omit<SchedulerOptions, 'logger'>> & { logger: Logger };
  readonly #queue: AnnouncementRunner[] = [];
  #current: AnnouncementRunner | undefined;
  #draining = false;

  constructor(options: SchedulerOptions) {
    super();
    this.#options = {
      system: options.system,
      logger: options.logger ?? silentLogger,
      maxQueued: options.maxQueued ?? 10,
      topologyTimeoutMs: options.topologyTimeoutMs ?? 10_000,
      restoreVerifyMs: options.restoreVerifyMs ?? 3000,
    };
  }

  /** Announcements waiting behind the current one. */
  get queued(): number {
    return this.#queue.length;
  }

  /** The id of the announcement in progress, if any. */
  get current(): string | undefined {
    return this.#current?.id;
  }

  submit(spec: AnnouncementSpec): AnnouncementHandle {
    if (this.#draining) {
      throw new ServiceUnavailableError('The server is shutting down', {
        headers: { 'Retry-After': RETRY_AFTER_SECONDS },
      });
    }

    if (this.#queue.length >= this.#options.maxQueued) {
      throw new ServiceUnavailableError(
        `Too many announcements are waiting (${this.#options.maxQueued}); try again later`,
        { headers: { 'Retry-After': RETRY_AFTER_SECONDS } },
      );
    }

    const id = randomUUID();
    const runner = new AnnouncementRunner(id, spec, {
      system: this.#options.system,
      logger: this.#options.logger.child({
        announcementId: id,
        source: spec.source,
        requestId: spec.requestId,
      }),
      topologyTimeoutMs: this.#options.topologyTimeoutMs,
      restoreVerifyMs: this.#options.restoreVerifyMs,
      onTransition: (transition) => {
        if (transition.state === 'cancelled') {
          this.#remove(runner);
        }

        this.emit('transition', transition);
      },
    });
    this.#queue.push(runner);
    this.#pump();
    return runner;
  }

  /** Refuses new announcements and drops the waiting ones; the current one keeps playing. */
  beginShutdown(): void {
    this.#draining = true;
    for (const runner of [...this.#queue]) {
      runner.cancel();
    }
  }

  /**
   * Shuts down and stops the current announcement so its rooms are restored before the process
   * exits; resolves when that is done or after `timeoutMs`, whichever comes first.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.beginShutdown();
    const current = this.#current;
    if (!current) {
      return;
    }

    current.cancel();
    await Promise.race([
      current.done.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  #remove(runner: AnnouncementRunner): void {
    const index = this.#queue.indexOf(runner);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  #pump(): void {
    if (this.#current) {
      return;
    }

    const next = this.#queue.shift();
    if (!next) {
      return;
    }

    this.#current = next;
    void next
      .start()
      .catch(() => undefined)
      .then(() => {
        this.#current = undefined;
        this.#pump();
      });
  }
}
