import { Writable } from 'node:stream';

import { createLogger } from '../logger.ts';
import type { LogLevel, Logger } from '../logger.ts';

export interface CapturedLog {
  level: number;
  msg?: string;
  [key: string]: unknown;
}

export interface LogCapture {
  logger: Logger;
  /** Every log record written so far, parsed. */
  entries: () => CapturedLog[];
  /** Just the messages, in order. */
  messages: () => string[];
  /** The raw output, for asserting that a secret never appears anywhere. */
  text: () => string;
}

/** A real pino logger whose output is kept in memory for assertions. */
export function captureLogs(level: LogLevel = 'trace'): LogCapture {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  const logger = createLogger({ level, destination });
  const entries = (): CapturedLog[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as CapturedLog);

  return {
    logger,
    entries,
    messages: () => entries().map((entry) => entry.msg ?? ''),
    text: () => chunks.join(''),
  };
}
