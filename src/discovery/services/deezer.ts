import { ArgumentError } from '../errors.ts';
import type { ArtService, ArtServiceDeps } from '../music-services.ts';

const API_BASE = 'https://api.deezer.com';

interface DeezerTrack {
  album?: { cover_big?: string };
}

/** Parses a Sonos Deezer uri such as `x-sonosprog-http:tr-flac%3a3134041.flac?sid=2&flags=8224&sn=7`. */
export function parseDeezerTrackId(uri: string): string {
  const match = /x-.+?:.+%3a(\d+)\./.exec(uri);
  if (!match) {
    throw new ArgumentError(`Not a Deezer track uri: ${uri}`);
  }

  return match[1] as string;
}

export function createDeezerArtService(deps: ArtServiceDeps): ArtService {
  return {
    async tryGetHighResArt(uri) {
      const id = parseDeezerTrackId(uri);
      const response = await deps.fetch(`${API_BASE}/track/${id}`, {
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Deezer answered ${response.status} for track ${id}`);
      }

      const track = (await response.json()) as DeezerTrack;
      return track.album?.cover_big;
    },
  };
}
