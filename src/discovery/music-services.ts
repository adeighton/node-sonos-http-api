import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { UnknownServiceError } from './errors.ts';
import { createDeezerArtService } from './services/deezer.ts';
import { createSoundcloudArtService } from './services/soundcloud.ts';

/** Looks up high-resolution album art for one music service's track uris. */
export interface ArtService {
  tryGetHighResArt(uri: string): Promise<string | undefined>;
}

export interface ArtServiceDeps {
  fetch: typeof fetch;
  timeoutMs: number;
}

export type ArtLookup = (uri: string) => Promise<string | undefined>;

export interface ArtLookupDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  soundcloudClientId?: string;
  logger?: Logger;
  /** Override the service table (keyed by Sonos service id); mainly for tests. */
  services?: Record<string, ArtService>;
}

/** The Sonos service id (`sid=`) inside a track uri. */
export function getServiceId(uri: string): string | undefined {
  return /sid=(\d+)/.exec(uri)?.[1];
}

/**
 * Builds the lookup used by players to replace the player-relative album art with a
 * high-resolution one from the streaming service. Rejects for services it does not know, which
 * makes the caller fall back to the art the player itself serves.
 */
export function createArtLookup(deps: ArtLookupDeps = {}): ArtLookup {
  const logger = deps.logger ?? silentLogger;
  const serviceDeps: ArtServiceDeps = {
    fetch: deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? 5000,
  };
  const services: Record<string, ArtService> = deps.services ?? {
    2: createDeezerArtService(serviceDeps),
    160: createSoundcloudArtService({ ...serviceDeps, clientId: deps.soundcloudClientId }),
  };

  return async (uri) => {
    if (uri.startsWith('http')) {
      return uri;
    }

    const serviceId = getServiceId(uri);
    const service = serviceId === undefined ? undefined : services[serviceId];
    if (!service) {
      logger.trace({ uri }, 'no art service for uri');
      throw new UnknownServiceError(serviceId ?? 'none');
    }

    return service.tryGetHighResArt(uri);
  };
}
