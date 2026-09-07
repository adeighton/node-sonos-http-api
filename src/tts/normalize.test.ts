import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeForSpeech } from './normalize.ts';

describe('normalizeForSpeech', () => {
  it('keeps the text as given, escapes it for SSML and wraps it in <speak>', () => {
    const result = normalizeForSpeech('Tom & Jerry say "hi" <now>');
    assert.equal(result.kind, 'ssml');
    assert.equal(
      result.body,
      '<speak><p>Tom &amp; Jerry say &quot;hi&quot; &lt;now&gt;</p></speak>',
    );
    assert.equal(result.paragraphs, 1);
    assert.equal(result.billedChars, 'Tom & Jerry say "hi" <now>'.length);
  });

  it('turns blank-line paragraphs into <p> and single newlines into spaces', () => {
    const text =
      'Good morning!\nHi everyone.\n\n**Family History**\n\n\nToday is a day.  Really.\n';
    const result = normalizeForSpeech(text);
    assert.equal(
      result.body,
      '<speak><p>Good morning! Hi everyone.</p><p>**Family History**</p><p>Today is a day. Really.</p></speak>',
    );
    assert.equal(result.paragraphs, 3);
  });

  it('preserves markdown, emoji and other characters verbatim (only XML escaping)', () => {
    const text = '# Title\n- bullet *one*\n[link](http://x) 🎉';
    const result = normalizeForSpeech(text);
    assert.equal(result.body, '<speak><p># Title - bullet *one* [link](http://x) 🎉</p></speak>');
  });

  it('is deterministic and trims surrounding whitespace', () => {
    assert.equal(normalizeForSpeech('  hello  ').body, normalizeForSpeech('hello').body);
    assert.equal(normalizeForSpeech('a\r\n\r\nb').body, '<speak><p>a</p><p>b</p></speak>');
  });

  it('passes raw SSML through untouched apart from trimming', () => {
    const ssml = '  <speak>Dinner<break time="500ms"/>is ready &amp; waiting</speak>\n';
    const result = normalizeForSpeech(ssml);
    assert.equal(result.body, ssml.trim());
    assert.equal(result.kind, 'ssml');
    assert.equal(result.paragraphs, 1);
    assert.equal(result.billedChars, 'Dinner is ready & waiting'.length);
  });

  it('rejects an empty phrase', () => {
    assert.throws(() => normalizeForSpeech('   \n'), /empty/);
  });
});
