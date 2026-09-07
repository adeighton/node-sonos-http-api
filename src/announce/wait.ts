import type { Player, Zone } from '../discovery/player.ts';
import type { AnnounceSystem } from './types.ts';

export type WaitOutcome = 'matched' | 'stopped' | 'timeout' | 'aborted';

/**
 * Runs `attach` with a `finish` callback and settles with the first outcome: the one `attach`
 * reports, `timeout` after `timeoutMs`, or `aborted` through the signal. `detach` is always called
 * exactly once, so listeners never outlive the wait.
 */
function raceEvents<T extends WaitOutcome>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  attach: (finish: (outcome: T) => void) => () => void,
): Promise<T | 'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    let settled = false;
    let detach: () => void = () => {};
    const finish = (outcome: T | 'timeout' | 'aborted'): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      detach();
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    if (signal?.aborted) {
      finish('aborted');
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    detach = attach(finish);
  });
}

export interface TopologyWaitOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** Resolves once the zones satisfy `expected`; immediately when they already do. */
export function waitForTopology(
  system: AnnounceSystem,
  expected: (zones: Zone[]) => boolean,
  options: TopologyWaitOptions,
): Promise<'matched' | 'timeout' | 'aborted'> {
  if (expected(system.zones)) {
    return Promise.resolve('matched');
  }

  return raceEvents<'matched'>(options.timeoutMs, options.signal, (finish) => {
    const listener = (zones: Zone[]): void => {
      if (expected(zones)) {
        finish('matched');
      }
    };
    system.on('topology-change', listener);
    return () => system.off('topology-change', listener);
  });
}

export interface ClipEndOptions {
  durationMs: number;
  /** Extra time allowed after the clip's length before giving up on the STOPPED event. */
  marginMs?: number | undefined;
  /**
   * A STOPPED within this long of arming, without a PLAYING first, is the transport change
   * that preceded Play rather than the end of the clip.
   */
  graceMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Resolves when the player reports the clip has stopped. Arm it before calling `play()`: the
 * listener is attached synchronously, so the STOPPED at the end cannot be missed.
 */
export function waitForClipEnd(
  player: Pick<Player, 'on' | 'off'>,
  options: ClipEndOptions,
): Promise<'stopped' | 'timeout' | 'aborted'> {
  const graceMs = options.graceMs ?? 1000;
  const armedAt = Date.now();
  let playing = false;

  return raceEvents<'stopped'>(
    options.durationMs + (options.marginMs ?? 2000),
    options.signal,
    (finish) => {
      const listener = (state: string): void => {
        if (state === 'PLAYING') {
          playing = true;
        } else if (state === 'STOPPED' && (playing || Date.now() - armedAt >= graceMs)) {
          finish('stopped');
        }
      };
      player.on('playback-state', listener);
      return () => player.off('playback-state', listener);
    },
  );
}
