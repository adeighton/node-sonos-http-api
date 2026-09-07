// node:sqlite needs no flag on Node 24 (the process runs with --disable-warning=ExperimentalWarning);
// the plugin's feature table still lists it as experimental.
/* eslint-disable n/no-unsupported-features/node-builtins */
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
/* eslint-enable n/no-unsupported-features/node-builtins */

import type {
  AnnouncementPriority,
  AnnouncementResult,
  AnnouncementState,
  AnnouncementTransition,
} from '../announce/types.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';

export interface HistoryEntry {
  id: string;
  state: AnnouncementState;
  priority: AnnouncementPriority;
  source: string;
  /** What was asked for: `all`, `preset:firstfloor`, `room:Kitchen`, `rooms:Kitchen,Office`. */
  target: string;
  textPreview?: string | undefined;
  requestId?: string | undefined;
  idempotencyKey?: string | undefined;
  receivedAt: number;
  updatedAt: number;
  rooms: string[];
  result?: AnnouncementResult | undefined;
  error?: string | undefined;
}

export interface HistoryOptions {
  logger?: Logger | undefined;
  /** Entries older than this are deleted when the history is opened. Default 90. */
  retentionDays?: number | undefined;
  now?: (() => number) | undefined;
}

export interface ListOptions {
  limit?: number | undefined;
  state?: AnnouncementState | undefined;
}

type Row = Record<string, SQLOutputValue>;

const text = (value: SQLOutputValue | undefined): string =>
  typeof value === 'string' ? value : '';
const optional = (value: SQLOutputValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
const number = (value: SQLOutputValue | undefined): number =>
  typeof value === 'number' ? value : 0;

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    priority TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    text_preview TEXT,
    request_id TEXT,
    idempotency_key TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rooms TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS announcements_received ON announcements (received_at);
  CREATE INDEX IF NOT EXISTS announcements_key ON announcements (idempotency_key, received_at);
`;

function toEntry(row: Row): HistoryEntry {
  const result = optional(row.result);
  return {
    id: text(row.id),
    state: text(row.state) as AnnouncementState,
    priority: text(row.priority) as AnnouncementPriority,
    source: text(row.source),
    target: text(row.target),
    textPreview: optional(row.text_preview),
    requestId: optional(row.request_id),
    idempotencyKey: optional(row.idempotency_key),
    receivedAt: number(row.received_at),
    updatedAt: number(row.updated_at),
    rooms: JSON.parse(text(row.rooms) || '[]') as string[],
    result: result === undefined ? undefined : (JSON.parse(result) as AnnouncementResult),
    error: optional(row.error),
  };
}

/**
 * What happened to each announcement, in one SQLite table, so "did the 7am briefing play?" is a
 * query rather than a journal search. Fed by the scheduler's transitions; a few tiny writes per
 * announcement in WAL mode, so the SD card hardly notices.
 */
export class AnnouncementHistory {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #now: () => number;

  private constructor(db: DatabaseSync, options: HistoryOptions) {
    this.#db = db;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec(SCHEMA);
    this.prune((options.retentionDays ?? 90) * DAY_MS);
  }

  /** Opens (creating) the database file; falls back to memory, with a warning, when it cannot. */
  static open(file: string, options: HistoryOptions = {}): AnnouncementHistory {
    try {
      return new AnnouncementHistory(new DatabaseSync(file), options);
    } catch (error) {
      (options.logger ?? silentLogger).warn(
        { err: error, file },
        'could not open the announcement history; keeping it in memory for this run',
      );
      return new AnnouncementHistory(new DatabaseSync(':memory:'), options);
    }
  }

  /** Records every transition the scheduler emits; returns an unsubscribe function. */
  follow(scheduler: {
    on(event: 'transition', listener: (t: AnnouncementTransition) => void): unknown;
    off(event: 'transition', listener: (t: AnnouncementTransition) => void): unknown;
  }): () => void {
    const listener = (transition: AnnouncementTransition): void => {
      try {
        if (transition.state === 'queued') {
          this.record(transition);
        } else {
          this.update(transition);
        }
      } catch (error) {
        this.#logger.warn({ err: error, id: transition.id }, 'could not record the announcement');
      }
    };
    scheduler.on('transition', listener);
    return () => scheduler.off('transition', listener);
  }

  record(transition: AnnouncementTransition): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO announcements
           (id, state, priority, source, target, text_preview, request_id, idempotency_key,
            received_at, updated_at, rooms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.id,
        transition.state,
        transition.priority,
        transition.source,
        transition.target,
        transition.textPreview ?? null,
        transition.requestId ?? null,
        transition.idempotencyKey ?? null,
        transition.at,
        transition.at,
        JSON.stringify(transition.rooms ?? []),
      );
  }

  update(transition: AnnouncementTransition): void {
    this.#db
      .prepare(
        `UPDATE announcements
         SET state = ?, updated_at = ?,
             rooms = COALESCE(?, rooms), result = COALESCE(?, result), error = COALESCE(?, error)
         WHERE id = ?`,
      )
      .run(
        transition.state,
        transition.at,
        transition.rooms ? JSON.stringify(transition.rooms) : null,
        transition.result ? JSON.stringify(transition.result) : null,
        transition.error ?? null,
        transition.id,
      );
  }

  get(id: string): HistoryEntry | undefined {
    const row = this.#db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
    return row ? toEntry(row) : undefined;
  }

  /** Newest first. */
  list(options: ListOptions = {}): HistoryEntry[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const rows = options.state
      ? this.#db
          .prepare(
            'SELECT * FROM announcements WHERE state = ? ORDER BY received_at DESC, id LIMIT ?',
          )
          .all(options.state, limit)
      : this.#db
          .prepare('SELECT * FROM announcements ORDER BY received_at DESC, id LIMIT ?')
          .all(limit);
    return rows.map(toEntry);
  }

  /** The most recent announcement submitted with `key` no longer than `windowMs` ago. */
  findByIdempotencyKey(key: string, windowMs: number): HistoryEntry | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM announcements WHERE idempotency_key = ? AND received_at >= ?
         ORDER BY received_at DESC LIMIT 1`,
      )
      .get(key, this.#now() - windowMs);
    return row ? toEntry(row) : undefined;
  }

  /** Deletes entries received more than `olderThanMs` ago; returns how many. */
  prune(olderThanMs: number): number {
    const { changes } = this.#db
      .prepare('DELETE FROM announcements WHERE received_at < ?')
      .run(this.#now() - olderThanMs);
    return Number(changes);
  }

  close(): void {
    this.#db.close();
  }
}
