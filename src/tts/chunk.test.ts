import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chunkSpeech, textContent } from './chunk.ts';
import { normalizeForSpeech } from './normalize.ts';

const paragraph = (n: number, words = 40) =>
  Array.from({ length: words }, (_, i) => `p${n}w${i}`).join(' ') + '.';

describe('chunkSpeech', () => {
  it('keeps a short text as a single chunk', () => {
    const chunks = chunkSpeech(normalizeForSpeech('Hello there.\n\nSecond paragraph.'));
    assert.deepEqual(chunks, ['<speak><p>Hello there.</p><p>Second paragraph.</p></speak>']);
  });

  it('splits on paragraph boundaries once the target size is reached', () => {
    const text = [1, 2, 3, 4, 5, 6].map((n) => paragraph(n)).join('\n\n');
    const normalized = normalizeForSpeech(text);
    const chunks = chunkSpeech(normalized, { targetChars: 600, maxChars: 2500 });

    assert.ok(chunks.length >= 2, 'more than one chunk');
    for (const chunk of chunks) {
      assert.ok(chunk.startsWith('<speak>') && chunk.endsWith('</speak>'), 'each is a document');
      assert.ok(!chunk.includes('<p></p>'), 'no empty paragraphs');
      assert.ok(textContent(chunk).length <= 600 + 300, 'roughly the target size');
    }

    assert.equal(
      chunks.map(textContent).join(' '),
      textContent(normalized.body),
      'all the text survives, in order',
    );
    assert.ok(
      chunks.every((c) => /<\/p><\/speak>$/.test(c)),
      'chunks end on a paragraph',
    );
  });

  it('splits an oversized paragraph at sentence boundaries, never inside a tag', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here!`);
    const normalized = normalizeForSpeech(sentences.join(' '));
    const chunks = chunkSpeech(normalized, { targetChars: 200, maxChars: 300 });

    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) {
      assert.ok(textContent(chunk).length <= 300, `chunk within max: ${chunk.length}`);
      assert.ok(chunk.startsWith('<speak><p>') && chunk.endsWith('</p></speak>'));
      assert.ok(!/<[^>]*$/.test(chunk.slice(0, -'</p></speak>'.length)), 'no torn tag');
    }
    assert.equal(chunks.map(textContent).join(' '), textContent(normalized.body));
  });

  it('leaves raw SSML as one chunk', () => {
    const ssml = '<speak><prosody rate="slow">Slowly</prosody><break time="1s"/>done</speak>';
    assert.deepEqual(chunkSpeech(normalizeForSpeech(ssml)), [ssml]);
  });
});

describe('textContent', () => {
  it('strips tags and unescapes entities', () => {
    assert.equal(
      textContent('<speak><p>Tom &amp; Jerry</p><p>&lt;x&gt;</p></speak>'),
      'Tom & Jerry <x>',
    );
  });
});
