import type { SearchTerms } from './types.ts';

/**
 * Splits `artist:… album:… track:…` specifiers out of a search term; text without specifiers is
 * kept whole in `term`.
 */
export function parseSearchTerms(term: string): SearchTerms {
  const result: SearchTerms = { term, artist: '', album: '', track: '' };
  const pattern = /(artist|album|track):/g;
  const markers = [...term.matchAll(pattern)];
  if (markers.length === 0) {
    return result;
  }

  result.term = '';
  markers.forEach((marker, index) => {
    const key = marker[1] as 'artist' | 'album' | 'track';
    const start = (marker.index ?? 0) + marker[0].length;
    const next = markers[index + 1];
    const end = next?.index ?? term.length;
    result[key] = term.slice(start, end).trim();
  });

  return result;
}

/** What a song search was really after, from the specifiers used. */
export function songSearchKind(terms: SearchTerms): 'song' | 'track' | 'artist' {
  if (terms.track !== '') {
    return 'track';
  }

  return terms.artist !== '' ? 'artist' : 'song';
}
