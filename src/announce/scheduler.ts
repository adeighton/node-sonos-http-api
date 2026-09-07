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
  /** How far an interrupted announcement rewinds before it carries on. Default 1 s. */
  resumeRewindMs?: number | undefined;
}

export interface SchedulerEvents {
  transition: [AnnouncementTransition];
}

/** What a caller that is refused should wait before trying again, in seconds. */
const RETRY_AFTER_SECONDS = '10';

/**
 * Plays announcements one at a time so their backups never capture each other's clips: urgent
 * ones first, otherwise in the order they arrive. An urgent announcement interrupts a playing
 * normal one, which resumes once every urgent one is done. Every state change is published as a
 * `transition` event.
 */
export class AnnouncementScheduler extends EventEmitter<SchedulerEvents> {
  readonly #options: Required<Omit<SchedulerOptions, 'logger'>> & { logger: Logger };
  readonly #queue: AnnouncementRunner[] = [];
  #current: AnnouncementRunner | undefined;
  /** A normal announcement parked by an urgent one, waiting to resume. */
  #suspended: AnnouncementRunner | undefined;
  #draining = false;

  constructor(options: SchedulerOptions) {
    super();
    this.#options = {
      system: options.system,
      logger: options.logger ?? silentLogger,
      maxQueued: options.maxQueued ?? 10,
      topologyTimeoutMs: options.topologyTimeoutMs ?? 10_000,
      restoreVerifyMs: options.restoreVerifyMs ?? 3000,
      resumeRewindMs: options.resumeRewindMs ?? 1000,
    };
  }

  /** Announcements waiting behind the current one (an interrupted one included). */
  get queued(): number {
    return this.#queue.length + (this.#suspended ? 1 : 0);
  }

  /** The id of the announcement in progress, if any. */
  get current(): string | undefined {
    return this.#current?.id;
  }

  get draining(): boolean {
    return this.#draining;
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
        priority: spec.priority ?? 'normal',
        requestId: spec.requestId,
      }),
      topologyTimeoutMs: this.#options.topologyTimeoutMs,
      restoreVerifyMs: this.#options.restoreVerifyMs,
      resumeRewindMs: this.#options.resumeRewindMs,
      onTransition: (transition) => {
        if (transition.state === 'cancelled') {
          this.#remove(runner);
        }

        this.emit('transition', transition);
        if (transition.state === 'playing') {
          this.#preemptIfUrgentWaits();
        }
      },
    });

    if (spec.priority === 'urgent') {
      const behindUrgent = this.#queue.findLastIndex((r) => r.spec.priority === 'urgent') + 1;
      this.#queue.splice(behindUrgent, 0, runner);
    } else {
      this.#queue.push(runner);
    }

    runner.notifyQueued();
    this.#pump();
    this.#preemptIfUrgentWaits();
    return runner;
  }

  /** A queued, playing or interrupted announcement by id. */
  find(id: string): AnnouncementHandle | undefined {
    return [this.#current, this.#suspended, ...this.#queue].find((runner) => runner?.id === id);
  }

  /** Refuses new announcements and drops the waiting ones; the current one keeps playing. */
  beginShutdown(): void {
    this.#draining = true;
    for (const runner of [...this.#queue]) {
      runner.cancel();
    }
  }

  /**
   * Shuts down and stops the current announcement (and one it interrupted) so their rooms are
   * restored before the process exits; resolves when that is done or after `timeoutMs`.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.beginShutdown();
    const active = [this.#current, this.#suspended].filter((r) => r !== undefined);
    if (active.length === 0) {
      return;
    }

    for (const runner of active) {
      runner.cancel();
    }

    await Promise.race([
      Promise.allSettled(active.map((runner) => runner.done)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  #remove(runner: AnnouncementRunner): void {
    const index = this.#queue.indexOf(runner);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  /** An urgent announcement at the head of the queue takes the speakers from a playing normal one. */
  #preemptIfUrgentWaits(): void {
    const victim = this.#current;
    if (
      !victim ||
      this.#suspended ||
      victim.spec.priority === 'urgent' ||
      victim.state !== 'playing' ||
      this.#queue[0]?.spec.priority !== 'urgent'
    ) {
      return;
    }

    void victim.interrupt().then((outcome) => {
      if (outcome === 'interrupted' && this.#current === victim) {
        this.#suspended = victim;
        this.#current = undefined;
        this.#pump();
      }
    });
  }

  #pump(): void {
    if (this.#current) {
      return;
    }

    if (this.#queue[0]?.spec.priority === 'urgent') {
      this.#run(this.#queue.shift() as AnnouncementRunner);
    } else if (this.#suspended) {
      const resumed = this.#suspended;
      this.#suspended = undefined;
      this.#current = resumed;
      resumed.resume();
    } else {
      const next = this.#queue.shift();
      if (next) {
        this.#run(next);
      }
    }
  }

  #run(runner: AnnouncementRunner): void {
    this.#current = runner;
    void runner
      .start()
      .catch(() => undefined)
      .then(() => {
        if (this.#current === runner) {
          this.#current = undefined;
        }

        this.#pump();
      });
  }
}
