/**
 * Just enough MPEG audio knowledge to measure and join the MP3 streams Polly returns: a walk over
 * the frame headers. Polly emits bare MPEG frames (no ID3 container), all with one sample rate,
 * so pieces of one phrase can be concatenated frame by frame.
 */

export interface Mp3Info {
  frames: number;
  sampleRate: number;
  /** MPEG version: 1, 2 or 2.5. */
  version: 1 | 2 | 2.5;
  durationMs: number;
  /** Whether the stream starts with a Xing/Info (encoder metadata) frame. */
  hasInfoFrame: boolean;
}

interface FrameHeader {
  length: number;
  sampleRate: number;
  version: 1 | 2 | 2.5;
  samples: number;
  /** Byte offset of the side-info end, where a Xing/Info tag would sit. */
  tagOffset: number;
}

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

/** Parses a Layer III frame header at `offset`; undefined when the bytes are not one. */
function readFrameHeader(bytes: Uint8Array, offset: number): FrameHeader | undefined {
  if (offset + 4 > bytes.length) {
    return undefined;
  }

  const b1 = bytes[offset] ?? 0;
  const b2 = bytes[offset + 1] ?? 0;
  const b3 = bytes[offset + 2] ?? 0;
  const b4 = bytes[offset + 3] ?? 0;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) {
    return undefined;
  }

  const versionBits = (b2 >> 3) & 0x03;
  const layerBits = (b2 >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) {
    return undefined; // reserved version, or not Layer III
  }

  const version: 1 | 2 | 2.5 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const bitrateIndex = (b3 >> 4) & 0x0f;
  const rateIndex = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
    return undefined;
  }

  const bitrate = (version === 1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[String(version)]?.[rateIndex] ?? 0;
  if (bitrate === 0 || sampleRate === 0) {
    return undefined;
  }

  const samples = version === 1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + padding;
  const mono = ((b4 >> 6) & 0x03) === 3;
  const sideInfo = version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { length, sampleRate, version, samples, tagOffset: 4 + sideInfo };
}

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return 0;
  }

  const size =
    ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0);
  const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function endOfAudio(bytes: Uint8Array): number {
  const tail = bytes.length - 128;
  if (tail >= 0 && bytes[tail] === 0x54 && bytes[tail + 1] === 0x41 && bytes[tail + 2] === 0x47) {
    return tail;
  }

  return bytes.length;
}

function isInfoFrame(bytes: Uint8Array, offset: number, header: FrameHeader): boolean {
  const at = offset + header.tagOffset;
  const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
  return tag === 'Xing' || tag === 'Info';
}

interface Frame {
  offset: number;
  header: FrameHeader;
  info: boolean;
}

function frames(bytes: Uint8Array): Frame[] {
  const found: Frame[] = [];
  const end = endOfAudio(bytes);
  let offset = id3v2Length(bytes);
  while (offset + 4 <= end) {
    const header = readFrameHeader(bytes, offset);
    if (!header) {
      offset += 1; // resync on garbage
      continue;
    }

    found.push({ offset, header, info: isInfoFrame(bytes, offset, header) });
    offset += header.length;
  }

  return found;
}

export function parseMp3(bytes: Uint8Array): Mp3Info {
  const list = frames(bytes);
  const first = list[0];
  if (!first) {
    throw new Error('no MPEG audio frames found');
  }

  const samples = list.reduce((total, frame) => total + frame.header.samples, 0);
  return {
    frames: list.length,
    sampleRate: first.header.sampleRate,
    version: first.header.version,
    durationMs: Math.round((samples / first.header.sampleRate) * 1000),
    hasInfoFrame: first.info,
  };
}

/**
 * Joins MP3 parts of one format. Xing/Info frames are dropped from every part: they describe the
 * length of the stream they came from, and a player or parser that trusts one would stop
 * counting at the end of the first part.
 */
export function concatMp3(parts: Uint8Array[]): {
  bytes: Uint8Array;
  frames: number;
  durationMs: number;
} {
  const pieces: Uint8Array[] = [];
  let sampleRate = 0;
  let version: number | undefined;
  let count = 0;
  let samples = 0;

  parts.forEach((part, index) => {
    const list = frames(part);
    const first = list[0];
    if (!first) {
      throw new Error('no MPEG audio frames found');
    }

    if (index === 0) {
      sampleRate = first.header.sampleRate;
      version = first.header.version;
    } else if (first.header.sampleRate !== sampleRate || first.header.version !== version) {
      throw new Error('mismatched mp3 parameters between parts');
    }

    for (const frame of list) {
      if (frame.info) {
        continue;
      }

      pieces.push(part.subarray(frame.offset, frame.offset + frame.header.length));
      count += 1;
      samples += frame.header.samples;
    }
  });

  return {
    bytes: Buffer.concat(pieces),
    frames: count,
    durationMs: Math.round((samples / sampleRate) * 1000),
  };
}
