/**
 * Turns a phrase into the SSML document Polly synthesizes. The text is taken as given: nothing is
 * stripped or rewritten, only escaped. Blank lines become paragraphs so Polly pauses naturally and
 * chunking can split between them. Raw SSML (a `<speak>` document) passes through untouched.
 *
 * The result is deterministic and is also what the clip cache key is derived from.
 */
import { encode } from 'html-entities';

import { BadRequestError } from '../http/errors.ts';

export interface NormalizedSpeech {
  kind: 'ssml';
  /** A complete `<speak>…</speak>` document. */
  body: string;
  /** Characters Polly bills for: the text without tags. */
  billedChars: number;
  paragraphs: number;
}

export function isSsml(phrase: string): boolean {
  const trimmed = phrase.trim();
  return trimmed.startsWith('<speak') && trimmed.endsWith('</speak>');
}

/** Text without tags, entities decoded; used for billing estimates and tests. */
export function textOf(ssml: string): string {
  return ssml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeForSpeech(input: string): NormalizedSpeech {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new BadRequestError('The phrase is empty');
  }

  if (isSsml(trimmed)) {
    return {
      kind: 'ssml',
      body: trimmed,
      billedChars: textOf(trimmed).length,
      paragraphs: Math.max(1, (trimmed.match(/<p[\s>]/g) ?? []).length),
    };
  }

  const paragraphs = trimmed
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
  const body = `<speak>${paragraphs
    .map((paragraph) => `<p>${encode(paragraph, { level: 'xml' })}</p>`)
    .join('')}</speak>`;

  return {
    kind: 'ssml',
    body,
    billedChars: paragraphs.reduce((total, paragraph) => total + paragraph.length, 0),
    paragraphs: paragraphs.length,
  };
}
