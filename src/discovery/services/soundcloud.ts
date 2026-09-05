import { ArgumentError } from '../errors.ts';
import type { ArtService, ArtServiceDeps } from '../music-services.ts';

const API_BASE = 'https://api.soundcloud.com';

/** The client id upstream shipped with; override it with SOUNDCLOUD_CLIENT_ID. */
export const DEFAULT_SOUNDCLOUD_CLIENT_ID = '6b9ec970f07f410376f1db1dfa8d71b3';

interface SoundcloudTrack {
  artwork_url?: string | null;
}

/** Parses a Sonos SoundCloud uri such as `x-sonos-http:track%3a232202756.mp3?sid=160&flags=8224&sn=10`. */
export function parseSoundcloudTrackId(uri: string): string {
  const match = /x-sonos-http:track%3a(\d+)\./.exec(uri);
  if (!match) {
    throw new ArgumentError(`Not a SoundCloud track uri: ${uri}`);
  }

  return match[1] as string;
}

export function createSoundcloudArtService(
  deps: ArtServiceDeps & { clientId?: string },
): ArtService {
  const clientId = deps.clientId ?? DEFAULT_SOUNDCLOUD_CLIENT_ID;

  return {
    async tryGetHighResArt(uri) {
      const id = parseSoundcloudTrackId(uri);
      const url = new URL(`${API_BASE}/tracks/${id}`);
      url.searchParams.set('client_id', clientId);

      const response = await deps.fetch(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
      if (!response.ok) {
        throw new Error(`SoundCloud answered ${response.status} for track ${id}`);
      }

      const track = (await response.json()) as SoundcloudTrack;
      return track.artwork_url?.replace('large', 't500x500') ?? undefined;
    },
  };
}
