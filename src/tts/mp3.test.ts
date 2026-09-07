import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fixturePath } from '../testing/fixtures.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { fileDurationMs } from './duration.ts';
import { concatMp3, parseMp3 } from './mp3.ts';

const FRAME_MS = 27; // one MPEG-1 Layer III frame at 44.1 kHz is 26.1 ms

describe('parseMp3', () => {
  it('walks the frames of a real clip and agrees with music-metadata on its duration', async () => {
    const path = fixturePath('clip.mp3');
    const parsed = parseMp3(await readFile(path));
    const measured = await fileDurationMs(path);

    assert.ok(parsed.frames > 10, 'has frames');
    assert.ok(
      [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(parsed.sampleRate),
    );
    assert.ok(
      Math.abs(parsed.durationMs - measured) <= FRAME_MS,
      `${parsed.durationMs} vs ${measured}`,
    );
  });

  it('skips an ID3v2 header and an ID3v1 trailer', async () => {
    const audio = await readFile(fixturePath('clip.mp3'));
    const plain = parseMp3(audio);

    const id3v2 = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([3, 0, 0, 0, 0, 0, 10]), // version 3.0, no flags, size 10 (sync-safe)
      Buffer.alloc(10),
    ]);
    const id3v1 = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)]);
    const tagged = parseMp3(Buffer.concat([id3v2, audio, id3v1]));

    assert.equal(tagged.frames, plain.frames);
    assert.equal(tagged.durationMs, plain.durationMs);
  });

  it('rejects data with no MPEG frames', () => {
    assert.throws(() => parseMp3(Buffer.from('not an mp3 at all')), /no MPEG audio frames/);
  });
});

describe('concatMp3', () => {
  it('joins clips of the same format and the result measures as the sum', async () => {
    await withTempDir(async (dir) => {
      const audio = await readFile(fixturePath('clip.mp3'));
      const one = parseMp3(audio);

      const joined = concatMp3([audio, audio, audio]);
      const out = join(dir, 'joined.mp3');
      await writeFile(out, joined.bytes);

      // Encoder Info frames are dropped from every part.
      const dropped = one.hasInfoFrame ? 3 : 0;
      assert.equal(joined.frames, one.frames * 3 - dropped);
      const frameMs = (one.durationMs / one.frames) * dropped;
      assert.ok(Math.abs(joined.durationMs - (one.durationMs * 3 - frameMs)) <= FRAME_MS);
      const measured = await fileDurationMs(out);
      assert.ok(
        Math.abs(measured - joined.durationMs) <= FRAME_MS,
        `${measured} vs ${joined.durationMs}`,
      );
      assert.equal(parseMp3(joined.bytes).frames, joined.frames);
    });
  });

  it('refuses to join clips whose sample rate or version differ', async () => {
    const audio = await readFile(fixturePath('clip.mp3'));
    const first = parseMp3(audio);
    // A synthetic MPEG-1 Layer III stream at a sample rate the fixture does not use.
    const otherRate = first.sampleRate === 48000 ? 32000 : 48000;
    const other = syntheticMp3({ frames: 4, sampleRate: otherRate });
    assert.equal(parseMp3(other).sampleRate, otherRate);

    assert.throws(() => concatMp3([audio, other]), /mismatched mp3 parameters/);
  });

  it('drops Xing/Info frames from every part so nothing trusts a stale length', () => {
    const part = syntheticMp3({ frames: 3, sampleRate: 44100, infoFrame: true });
    assert.equal(parseMp3(part).frames, 4, 'the info frame counts as a frame when parsed alone');
    assert.equal(parseMp3(part).hasInfoFrame, true);

    const joined = concatMp3([part, part]);
    assert.equal(joined.frames, 3 + 3, 'audio frames only');
    assert.equal(parseMp3(joined.bytes).hasInfoFrame, false);
  });
});

/** MPEG-1 Layer III, 128 kbit/s, mono, silent frames; optionally prefixed with an Info frame. */
function syntheticMp3(options: { frames: number; sampleRate: number; infoFrame?: boolean }) {
  const rateIndex = { 44100: 0, 48000: 1, 32000: 2 }[options.sampleRate];
  assert.ok(rateIndex !== undefined, 'supported synthetic sample rate');
  const frameLength = Math.floor((144 * 128_000) / options.sampleRate);
  const frame = (): Buffer => {
    const bytes = Buffer.alloc(frameLength);
    bytes[0] = 0xff;
    bytes[1] = 0xfb; // MPEG-1, Layer III, no CRC
    bytes[2] = (9 << 4) | (rateIndex << 2); // 128 kbit/s, no padding
    bytes[3] = 0xc0; // single channel
    return bytes;
  };
  const frames = Array.from({ length: options.frames }, frame);
  if (options.infoFrame) {
    const info = frame();
    info.write('Info', 4 + 17); // where a mono MPEG-1 stream carries the Xing/Info tag
    frames.unshift(info);
  }

  return Buffer.concat(frames);
}
