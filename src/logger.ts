import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import pretty from 'pino-pretty';

export type Logger = PinoLogger;

export type LogFormat = 'pretty' | 'json';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** `pretty` (default) is human-readable for journald / terminals; `json` is one JSON object per line. */
  format?: LogFormat;
  /** Where to write; overrides `format`. Used by tests to capture output. */
  destination?: NodeJS.WritableStream;
}

/** Object paths that must never reach the log output. */
const REDACT_PATHS = [
  'auth.password',
  'aws.credentials.accessKeyId',
  'aws.credentials.secretAccessKey',
  'spotify.clientSecret',
  'settings.auth.password',
  'settings.aws.credentials.accessKeyId',
  'settings.aws.credentials.secretAccessKey',
  'settings.spotify.clientSecret',
];

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions = {
    level: options.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };

  if (options.destination) {
    return pino(pinoOptions, options.destination);
  }

  if (options.format === 'json') {
    return pino(pinoOptions);
  }

  return pino(
    pinoOptions,
    pretty({
      colorize: process.stdout.isTTY === true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    }),
  );
}

/** A logger that discards everything; the default for library code when none is injected. */
export const silentLogger: Logger = pino({ level: 'silent' });
