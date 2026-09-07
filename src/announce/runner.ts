import { withTransientRetry } from '../discovery/retry.ts';
import { errorMessage } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import { deferred } from '../util/deferred.ts';
import type { Deferred } from '../util/deferred.ts';
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
  /** How far an interrupted announcement rewinds before it carries on. */
  resumeRewindMs: number;
  onTransition: (transition: AnnouncementTransition) => void;
}

/** Thrown inside the run to unwind it when `cancel()` was called; never leaves the runner. */
class CancelledError extends Error {
  constructor() {
    super('announcement cancelled');
    this.name = 'CancelledError';
  }
}

/** A clip whose remaining length is within this of its end is not worth resuming. */
const RESUME_MIN_REMAINING_MS = 1000;

/**
 * One announcement from submission to restored rooms. The clip is prepared as soon as the runner
 * exists, so text-to-speech overlaps the queue wait and the regrouping; `start()` is called by
 * the scheduler when the speakers are free. An urgent announcement can `interrupt()` a playing
 * one, which pauses and remembers its position until `resume()`.
 */
export class AnnouncementRunner implements AnnouncementHandle {
  readonly id: string;
  readonly spec: AnnouncementSpec;
  readonly done: Promise<AnnouncementResult>;
  state: AnnouncementState = 'queued';

  readonly #options: RunnerOptions;
  readonly #logger: Logger;
  readonly #clip: Promise<PreparedClip>;
  readonly #cancel = new AbortController();
  readonly #submittedAt = Date.now();
  readonly #timings: StageTimings = { totalMs: 0 };
  readonly #settled: Deferred<AnnouncementResult>;
  #interruptions = 0;
  /** Aborts the current wait for the end of the clip (cancel or interrupt). */
  #waiter: AbortController | undefined;
  #interruptRequested = false;
  #interrupted: Deferred<'interrupted'> | undefined;
  #resumed: Deferred<void> | undefined;

  constructor(id: string, spec: AnnouncementSpec, options: RunnerOptions) {
    this.id = id;
    this.spec = spec;
    this.#options = options;
    this.#logger = options.logger;
    this.#settled = deferred<AnnouncementResult>();
    this.done = this.#settled.promise;
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
      this.#cancel.abort();
      this.#waiter?.abort();
    } else if (this.state === 'interrupted') {
      // Takes effect on resume, so the restore does not fight the urgent announcement.
      this.#cancel.abort();
    }
  }

  /**
   * Pauses a playing announcement so an urgent one can take the speakers; resolves once it is
   * parked (`interrupted`) or, when the clip had all but ended, when it is over (`ended`).
   */
  interrupt(): Promise<'interrupted' | 'ended'> {
    if (this.state !== 'playing' || this.#interruptRequested) {
      return Promise.resolve('ended');
    }

    this.#interruptRequested = true;
    this.#interrupted = deferred<'interrupted'>();
    this.#waiter?.abort();
    const over = this.done.then(
      (): 'ended' => 'ended',
      (): 'ended' => 'ended',
    );
    return Promise.race([this.#interrupted.promise, over]);
  }

  /** Lets an interrupted announcement carry on from where it was paused. */
  resume(): void {
    this.#resumed?.release();
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
      this.#fail(error, []);
      return;
    }

    const rooms = plan.preset.players.map((player) => player.roomName);
    let clip: PreparedClip | undefined;
    let failure: unknown;
    try {
      clip = await this.#start(plan);
      await this.#playThrough(plan, clip);
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
      this.#fail(failure, rooms, outcome);
    } else {
      this.#finish('done', clip, rooms, outcome);
    }
  }

  /** Forms the group and sets the clip on the coordinator once it is ready. */
  async #start(plan: AnnouncementPlan): Promise<PreparedClip> {
    await this.#formGroup(plan);
    const clip = await this.#clip;
    this.#checkCancelled();
    await plan.coordinator.setAVTransport(clip.uri);
    this.#checkCancelled();
    return clip;
  }

  async #formGroup(plan: AnnouncementPlan): Promise<void> {
    const { system, topologyTimeoutMs } = this.#options;
    const groupedAt = Date.now();
    await withTransientRetry(() => system.applyPreset(plan.preset), {
      label: 'announcement group',
      retryOn: () => true,
      logger: this.#logger,
    });
    this.#timings.groupMs = (this.#timings.groupMs ?? 0) + Date.now() - groupedAt;
    this.#checkCancelled();

    const topologyAt = Date.now();
    const regrouped = await waitForTopology(system, plan.expectedTopology, {
      timeoutMs: topologyTimeoutMs,
      signal: this.#cancel.signal,
    });
    this.#timings.topologyMs = (this.#timings.topologyMs ?? 0) + Date.now() - topologyAt;
    this.#checkCancelled();
    if (regrouped === 'timeout') {
      this.#logger.warn('players did not regroup in time, playing anyway');
    }
  }

  /** Plays the clip to its end, parking and resuming as many times as urgent announcements ask. */
  async #playThrough(plan: AnnouncementPlan, clip: PreparedClip): Promise<void> {
    let offsetMs = 0;
    this.#transition('playing');
    for (;;) {
      const segment = await this.#playFrom(plan, clip, offsetMs);
      if (segment.outcome !== 'interrupted') {
        return;
      }

      const position = await this.#park(plan, clip, segment.elapsedMs + offsetMs);
      if (position === undefined) {
        return;
      }

      this.#interruptions += 1;
      this.#transition('interrupted');
      this.#interrupted?.release('interrupted');
      this.#resumed = deferred<void>();
      await this.#resumed.promise;
      this.#checkCancelled();

      offsetMs = Math.max(0, position - this.#options.resumeRewindMs);
      await this.#reinstate(plan, clip, offsetMs);
      this.#interruptRequested = false;
      this.#transition('playing');
    }
  }

  /** Arms the end-of-clip listener, plays, and waits for the end, a cancel or an interrupt. */
  async #playFrom(
    plan: AnnouncementPlan,
    clip: PreparedClip,
    offsetMs: number,
  ): Promise<{ outcome: 'ended' | 'interrupted'; elapsedMs: number }> {
    const playedAt = Date.now();
    this.#waiter = new AbortController();
    // Armed before Play so the STOPPED at the end of the clip cannot slip past.
    const ended = waitForClipEnd(plan.coordinator, {
      durationMs: Math.max(0, clip.durationMs - offsetMs),
      signal: this.#waiter.signal,
    });
    if (this.#interruptRequested) {
      // Asked for between the `playing` transition and arming the waiter.
      this.#waiter.abort();
    }

    try {
      await plan.coordinator.play();
      const outcome = await ended;
      if (outcome !== 'aborted') {
        return { outcome: 'ended', elapsedMs: Date.now() - playedAt };
      }

      if (this.#cancel.signal.aborted) {
        await plan.coordinator.stop().catch((error: unknown) => {
          this.#logger.warn({ err: error }, 'could not stop the cancelled announcement');
        });
        throw new CancelledError();
      }

      return { outcome: 'interrupted', elapsedMs: Date.now() - playedAt };
    } finally {
      this.#timings.playMs = (this.#timings.playMs ?? 0) + Date.now() - playedAt;
      this.#waiter = undefined;
    }
  }

  /**
   * Pauses the clip and works out where it stopped: the player's own position when it reports
   * one, the clock otherwise. Undefined when so little is left that resuming is not worth it.
   */
  async #park(
    plan: AnnouncementPlan,
    clip: PreparedClip,
    clockMs: number,
  ): Promise<number | undefined> {
    try {
      await plan.coordinator.pause();
    } catch (error) {
      this.#logger.warn({ err: error }, 'could not pause for the urgent announcement');
      return undefined;
    }

    let positionMs = clockMs;
    try {
      const { relTimeSec } = await plan.coordinator.getPosition();
      if (relTimeSec > 0) {
        positionMs = relTimeSec * 1000;
      }
    } catch (error) {
      this.#logger.debug({ err: error }, 'no position from the player, using the clock');
    }

    if (positionMs >= clip.durationMs - RESUME_MIN_REMAINING_MS) {
      this.#logger.debug({ positionMs }, 'the clip had all but ended; not resuming');
      return undefined;
    }

    this.#logger.info({ positionMs }, 'paused for an urgent announcement');
    return positionMs;
  }

  /** Puts the group, the clip and the position back before carrying on. */
  async #reinstate(plan: AnnouncementPlan, clip: PreparedClip, offsetMs: number): Promise<void> {
    if (!plan.expectedTopology(this.#options.system.zones)) {
      this.#logger.debug('the group changed while interrupted; forming it again');
      await this.#formGroup(plan);
    }

    if (plan.coordinator.avTransportUri !== clip.uri) {
      await plan.coordinator.setAVTransport(clip.uri);
    }

    this.#checkCancelled();
    await plan.coordinator.timeSeek(Math.floor(offsetMs / 1000));
    this.#logger.info({ offsetMs }, 'resuming the interrupted announcement');
  }

  #checkCancelled(): void {
    if (this.#cancel.signal.aborted) {
      throw new CancelledError();
    }
  }

  #fail(
    error: unknown,
    rooms: string[],
    outcome?: Pick<AnnouncementResult, 'restore' | 'warnings'>,
  ): void {
    this.#timings.totalMs = Date.now() - this.#submittedAt;
    this.#logger.warn(
      { err: error, rooms, timings: this.#timings, ...outcome },
      'announcement failed',
    );
    this.#transition('failed', { error: errorMessage(error) });
    this.#settled.reject(error);
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
      priority: this.spec.priority ?? 'normal',
      rooms,
      interruptions: this.#interruptions,
      clip,
      restore: outcome.restore,
      warnings: outcome.warnings,
      timings: this.#timings,
    };
    this.#transition(state, { result });
    this.#logger.info(
      { rooms, restore: result.restore, warnings: result.warnings, timings: result.timings },
      `announcement ${state}`,
    );
    this.#settled.resolve(result);
  }

  #transition(
    state: AnnouncementState,
    extra: Pick<AnnouncementTransition, 'result' | 'error'> = {},
  ): void {
    const previousState = this.state;
    this.state = state;
    this.#options.onTransition({
      id: this.id,
      state,
      previousState,
      source: this.spec.source,
      priority: this.spec.priority ?? 'normal',
      requestId: this.spec.requestId,
      at: Date.now(),
      ...extra,
    });
  }
}
