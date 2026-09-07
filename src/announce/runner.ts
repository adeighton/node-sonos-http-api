import { withTransientRetry } from '../discovery/retry.ts';
import type { Logger } from '../logger.ts';
import { planAnnouncement } from './plan.ts';
import type { AnnouncementPlan } from './plan.ts';
import { captureRestorePlan, runRestore } from './restore.ts';
import type { RestorePlan } from './restore.ts';
import type {
  AnnounceSystem,
  AnnouncementHandle,
  AnnouncementResult,
  AnnouncementSpec,
  AnnouncementState,
  AnnouncementTransition,
  PreparedClip,
  StageTimings,
} from './types.ts';
import { waitForClipEnd, waitForTopology } from './wait.ts';

export interface RunnerOptions {
  system: AnnounceSystem;
  logger: Logger;
  /** How long to wait for the players to regroup before playing anyway. */
  topologyTimeoutMs: number;
  /** How long the restore waits for the topology to show the groups back in place. */
  restoreVerifyMs: number;
  onTransition: (transition: AnnouncementTransition) => void;
}

/** Thrown inside the run to unwind it when `cancel()` was called; never leaves the runner. */
class CancelledError extends Error {
  constructor() {
    super('announcement cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * One announcement from submission to restored rooms. The clip is prepared as soon as the runner
 * exists, so text-to-speech overlaps the queue wait and the regrouping; `start()` is called by
 * the scheduler when the speakers are free.
 */
export class AnnouncementRunner implements AnnouncementHandle {
  readonly id: string;
  readonly spec: AnnouncementSpec;
  readonly done: Promise<AnnouncementResult>;
  state: AnnouncementState = 'queued';

  readonly #options: RunnerOptions;
  readonly #logger: Logger;
  readonly #clip: Promise<PreparedClip>;
  readonly #abort = new AbortController();
  readonly #submittedAt = Date.now();
  readonly #timings: StageTimings = { totalMs: 0 };
  #settle: { resolve: (result: AnnouncementResult) => void; reject: (error: unknown) => void };

  constructor(id: string, spec: AnnouncementSpec, options: RunnerOptions) {
    this.id = id;
    this.spec = spec;
    this.#options = options;
    this.#logger = options.logger;
    this.#settle = { resolve: () => {}, reject: () => {} };
    this.done = new Promise((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.#clip = spec.prepare().then((clip) => {
      this.#timings.prepareMs = Date.now() - this.#submittedAt;
      return clip;
    });
    // Nobody may ever await the clip (cancelled while queued); the error surfaces in start().
    this.#clip.catch(() => undefined);
  }

  /** Runs the announcement; resolves with the result or rejects with what stopped it. */
  start(): Promise<AnnouncementResult> {
    if (this.state === 'queued') {
      void this.#run();
    }

    return this.done;
  }

  cancel(): void {
    if (this.state === 'queued') {
      this.#finish('cancelled', undefined, [], { restore: 'ok', warnings: [] });
    } else if (this.state === 'starting' || this.state === 'playing') {
      this.#abort.abort();
    }
  }

  async #run(): Promise<void> {
    this.#timings.queuedMs = Date.now() - this.#submittedAt;
    this.#transition('starting');
    let plan: AnnouncementPlan;
    let restorePlan: RestorePlan;
    try {
      plan = planAnnouncement(this.#options.system, this.spec);
      restorePlan = captureRestorePlan(this.#options.system, plan);
    } catch (error) {
      this.#transition('failed');
      this.#settle.reject(error);
      return;
    }

    const rooms = plan.preset.players.map((player) => player.roomName);
    let clip: PreparedClip | undefined;
    let failure: unknown;
    try {
      clip = await this.#play(plan);
    } catch (error) {
      failure = error;
    }

    this.#transition('restoring');
    const restoredAt = Date.now();
    const outcome = await runRestore(this.#options.system, restorePlan, {
      logger: this.#logger,
      verifyTimeoutMs: this.#options.restoreVerifyMs,
    });
    this.#timings.restoreMs = Date.now() - restoredAt;

    if (failure instanceof CancelledError) {
      this.#finish('cancelled', clip, rooms, outcome);
    } else if (failure !== undefined) {
      this.#timings.totalMs = Date.now() - this.#submittedAt;
      this.#logger.warn(
        { err: failure, rooms, timings: this.#timings, ...outcome },
        'announcement failed',
      );
      this.#transition('failed');
      this.#settle.reject(failure);
    } else {
      this.#finish('done', clip, rooms, outcome);
    }
  }

  /** Forms the group, sets the clip once it is ready, plays it and waits for it to end. */
  async #play(plan: AnnouncementPlan): Promise<PreparedClip> {
    const { system, topologyTimeoutMs } = this.#options;
    const signal = this.#abort.signal;
    const groupedAt = Date.now();
    await withTransientRetry(() => system.applyPreset(plan.preset), {
      label: 'announcement group',
      retryOn: () => true,
      logger: this.#logger,
    });
    this.#timings.groupMs = Date.now() - groupedAt;
    this.#checkCancelled();

    const topologyAt = Date.now();
    const regrouped = await waitForTopology(system, plan.expectedTopology, {
      timeoutMs: topologyTimeoutMs,
      signal,
    });
    this.#timings.topologyMs = Date.now() - topologyAt;
    this.#checkCancelled();
    if (regrouped === 'timeout') {
      this.#logger.warn('players did not regroup in time, playing anyway');
    }

    const clip = await this.#clip;
    this.#checkCancelled();
    await plan.coordinator.setAVTransport(clip.uri);
    this.#checkCancelled();

    this.#transition('playing');
    const playedAt = Date.now();
    // Armed before Play so the STOPPED at the end of the clip cannot slip past.
    const ended = waitForClipEnd(plan.coordinator, { durationMs: clip.durationMs, signal });
    try {
      await plan.coordinator.play();
      if ((await ended) === 'aborted') {
        await plan.coordinator.stop().catch((error: unknown) => {
          this.#logger.warn({ err: error }, 'could not stop the cancelled announcement');
        });
        throw new CancelledError();
      }
    } finally {
      this.#timings.playMs = Date.now() - playedAt;
    }

    return clip;
  }

  #checkCancelled(): void {
    if (this.#abort.signal.aborted) {
      throw new CancelledError();
    }
  }

  #finish(
    state: 'done' | 'cancelled',
    clip: PreparedClip | undefined,
    rooms: string[],
    outcome: Pick<AnnouncementResult, 'restore' | 'warnings'>,
  ): void {
    this.#timings.totalMs = Date.now() - this.#submittedAt;
    const result: AnnouncementResult = {
      id: this.id,
      state,
      source: this.spec.source,
      rooms,
      clip,
      restore: outcome.restore,
      warnings: outcome.warnings,
      timings: this.#timings,
    };
    this.#transition(state);
    this.#logger.info(
      { rooms, restore: result.restore, warnings: result.warnings, timings: result.timings },
      `announcement ${state}`,
    );
    this.#settle.resolve(result);
  }

  #transition(state: AnnouncementState): void {
    const previousState = this.state;
    this.state = state;
    this.#options.onTransition({
      id: this.id,
      state,
      previousState,
      source: this.spec.source,
      requestId: this.spec.requestId,
      at: Date.now(),
    });
  }
}
