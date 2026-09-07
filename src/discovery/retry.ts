/**
 * One retry for player commands that fail for transient reasons: a player busy regrouping
 * answers late or with a bare 500. Refusals carrying a UPnP fault are deliberate and are never
 * retried by default; callers that know a specific fault is momentary (Play right after a
 * transport change answering 701) pass their own predicate.
 */
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { RequestFailedError, RequestTimeoutError, SoapFaultError } from './errors.ts';

export interface RetryOptions {
  /** Names the command in the log line. */
  label: string;
  /** Total attempts including the first; default 2. */
  attempts?: number;
  /** Pause before a retry; default 300 ms. */
  backoffMs?: number;
  /** What counts as transient; default `isTransientFault`. */
  retryOn?: (error: unknown) => boolean;
  logger?: Logger;
}

/** A timeout, or a gateway-style failure without a UPnP fault in it. */
export function isTransientFault(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) {
    return true;
  }

  return (
    error instanceof RequestFailedError &&
    !(error instanceof SoapFaultError) &&
    error.statusCode >= 500
  );
}

/** UPnP 701: the player cannot do that yet, typically Play right after a transport change. */
export function isNotReadyFault(error: unknown): boolean {
  return error instanceof SoapFaultError && error.errorCode === 701;
}

/** Plays, retrying once after a second when the player answers 701 because it is still switching. */
export function playWhenReady(player: { play(): Promise<void> }, logger?: Logger): Promise<void> {
  return withTransientRetry(() => player.play(), {
    label: 'Play',
    backoffMs: 1000,
    retryOn: isNotReadyFault,
    logger,
  });
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 2;
  const backoffMs = options.backoffMs ?? 300;
  const retryOn = options.retryOn ?? isTransientFault;
  const logger = options.logger ?? silentLogger;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !retryOn(error)) {
        throw error;
      }

      logger.warn({ err: error, command: options.label, attempt }, 'command failed, retrying');
      await pause(backoffMs);
    }
  }
}

/** The global timer, not timers/promises: node:test mock timers only advance the former. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
