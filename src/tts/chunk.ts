/**
 * Splits a normalized SSML document into pieces Polly will accept (SynthesizeSpeech takes at most
 * 3000 billed characters) and that can be synthesized in parallel. Paragraph boundaries come
 * first; a paragraph that is too long on its own is split between sentences. Tags are never cut.
 */
import type { NormalizedSpeech } from './normalize.ts';
import { textOf } from './normalize.ts';

export interface ChunkOptions {
  /** Preferred size of a chunk, in billed characters. */
  targetChars?: number;
  /** Hard ceiling per chunk, kept under Polly's 3000 with room for tags. */
  maxChars?: number;
}

const DEFAULT_TARGET = 800;
const DEFAULT_MAX = 2500;

export { textOf as textContent };

function paragraphsOf(body: string): string[] | undefined {
  const inner = body.replace(/^<speak>/, '').replace(/<\/speak>$/, '');
  const parts = inner.match(/<p>[\s\S]*?<\/p>/g);
  if (!parts || parts.join('') !== inner) {
    return undefined;
  }

  return parts.map((part) => part.slice('<p>'.length, -'</p>'.length));
}

/** Sentence-sized pieces of escaped paragraph text; a run with no sentence end stays whole. */
function sentencesOf(paragraph: string): string[] {
  const pieces = paragraph.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  return (pieces ?? [paragraph]).map((piece) => piece.trim()).filter((piece) => piece.length > 0);
}

function billed(escaped: string): number {
  return textOf(escaped).length;
}

/** Packs units into chunks of about `target` billed characters; a lone oversized unit stays whole. */
function pack(units: string[], target: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const unit of units) {
    const length = billed(unit);
    if (current.length > 0 && size + length > target) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    current.push(unit);
    size += length;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function chunkSpeech(speech: NormalizedSpeech, options: ChunkOptions = {}): string[] {
  const target = options.targetChars ?? DEFAULT_TARGET;
  const max = options.maxChars ?? DEFAULT_MAX;
  const paragraphs = paragraphsOf(speech.body);
  if (!paragraphs || speech.billedChars <= target) {
    // Raw SSML, or short enough: one document.
    return [speech.body];
  }

  // Paragraphs that fit stay whole; oversized ones become runs of sentences.
  const chunks: string[] = [];
  const paragraphGroups = pack(paragraphs, target);
  for (const group of paragraphGroups) {
    if (group.length === 1 && billed(group[0] ?? '') > max) {
      for (const sentences of pack(sentencesOf(group[0] ?? ''), target)) {
        chunks.push(`<speak><p>${sentences.join(' ')}</p></speak>`);
      }
    } else {
      chunks.push(`<speak>${group.map((paragraph) => `<p>${paragraph}</p>`).join('')}</speak>`);
    }
  }

  return chunks;
}
