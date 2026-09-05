import type { ActionContext, ActionRegistry, ActionSystem } from '../actions/registry.ts';
import type { Player } from '../discovery/player.ts';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from './errors.ts';

export const NO_SYSTEM_MESSAGE =
  'No Sonos system has been discovered yet. If this does not resolve itself within a few seconds, ' +
  'check that this server and the players share a network, or set discoveryHosts.';

/**
 * Splits a raw (still percent-encoded) request path into decoded segments, so that `%2F`
 * inside a value survives as a slash and a bad escape becomes a 400 instead of a crash.
 */
export function decodePathSegments(pathname: string): string[] {
  const raw = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (raw === '') {
    return [];
  }

  return raw.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch (error) {
      throw new BadRequestError(
        `The path segment '${segment}' could not be URI decoded. Percent escapes (%xx) must be valid hexadecimal.`,
        { cause: error },
      );
    }
  });
}

export interface ResolvedRequest {
  player: Player;
  action: string;
  values: string[];
}

/**
 * `/{room}/{action}/{values...}` when the first segment names a room, otherwise
 * `/{action}/{values...}` against any player.
 */
export function resolveRequest(system: ActionSystem, segments: string[]): ResolvedRequest {
  if (system.zones.length === 0) {
    throw new ServiceUnavailableError(NO_SYSTEM_MESSAGE);
  }

  const first = segments[0] ?? '';
  const named = system.getPlayer(first);
  if (named) {
    return { player: named, action: (segments[1] ?? '').toLowerCase(), values: segments.slice(2) };
  }

  const anyPlayer = system.getAnyPlayer();
  if (!anyPlayer) {
    throw new ServiceUnavailableError(NO_SYSTEM_MESSAGE);
  }

  return { player: anyPlayer, action: first.toLowerCase(), values: segments.slice(1) };
}

/** Actions that return nothing answer `{ status: 'success' }`, like the original API. */
export function normalizeResult(result: unknown): unknown {
  return result === undefined || result === null ? { status: 'success' } : result;
}

export async function runAction(
  registry: ActionRegistry,
  context: ActionContext,
  actionName: string,
  values: string[],
): Promise<unknown> {
  const action = registry.get(actionName);
  if (!action) {
    throw new NotFoundError(`Action '${actionName}' not found`);
  }

  return normalizeResult(await action(context, values));
}
