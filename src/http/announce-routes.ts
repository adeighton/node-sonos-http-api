import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RequestIdVariables } from 'hono/request-id';

import { clipFile, speech, textPreview } from '../actions/announce.ts';
import type { PrepareDeps } from '../actions/announce.ts';
import type { ActionSystem, AnnouncerLike } from '../actions/registry.ts';
import type { AnnounceTarget, AnnouncementSpec } from '../announce/types.ts';
import type { AnnouncementHistory } from '../history/sqlite.ts';
import type { Logger } from '../logger.ts';
import type { PresetStore } from '../presets/store.ts';
import {
  announceBodySchema,
  listQuerySchema,
  parseBody,
  roomsOf,
  ttsBodySchema,
} from './announce-schema.ts';
import type { AnnounceBody } from './announce-schema.ts';
import { ConflictError, NotFoundError } from './errors.ts';

export type HistoryLike = Pick<AnnouncementHistory, 'get' | 'list' | 'findByIdempotencyKey'>;

export interface AnnounceRouteDeps extends Omit<PrepareDeps, 'publicBaseUrl'> {
  system: Pick<ActionSystem, 'getPlayer'>;
  presets: Pick<PresetStore, 'get'>;
  announcer: AnnouncerLike;
  history: HistoryLike;
  logger: Logger;
  /** How long an idempotency key is remembered. */
  idempotencyWindowMs: number;
  /** Computed per request: the local endpoint is only known once discovery has run. */
  publicBaseUrl: () => string;
}

/** Request bodies are small JSON documents; a briefing is a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** The announcement states that can no longer be cancelled. */
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function resolveTarget(deps: AnnounceRouteDeps, body: AnnounceBody): AnnounceTarget {
  const { target } = body;
  if (target === 'all') {
    return { kind: 'all' };
  }

  if (!Array.isArray(target) && 'preset' in target) {
    const preset = deps.presets.get(target.preset);
    if (!preset) {
      throw new NotFoundError(`No preset named '${target.preset}'`);
    }

    return { kind: 'preset', preset, name: target.preset };
  }

  const rooms = (roomsOf(target) ?? []).map(({ name, volume }) => {
    const player = deps.system.getPlayer(name);
    if (!player) {
      throw new NotFoundError(`No room named '${name}'`);
    }

    return { player, volume };
  });
  return { kind: 'rooms', rooms };
}

async function buildSpec(
  deps: AnnounceRouteDeps,
  body: AnnounceBody,
  requestId: string,
  idempotencyKey: string | undefined,
): Promise<AnnouncementSpec> {
  const prepare = { tts: deps.tts, clips: deps.clips, publicBaseUrl: deps.publicBaseUrl() };
  const phrase = body.ssml ?? body.text;
  return {
    target: resolveTarget(deps, body),
    priority: body.priority,
    volume: body.volume,
    pauseOthers: body.pauseOthers,
    prepare:
      phrase !== undefined
        ? speech(prepare, { phrase, voice: body.voice, engine: body.engine })
        : await clipFile(prepare, body.clip),
    source: 'api',
    textPreview: phrase !== undefined ? textPreview(phrase) : body.clip,
    requestId,
    idempotencyKey,
  };
}

/**
 * The JSON announcement API: `POST /announce` queues one (202, or 200 with the result when
 * `wait` is set), `GET /announce` and `GET /announce/:id` read the history, `DELETE` cancels,
 * and `POST /tts` synthesizes a clip ahead of time. Mounted before the `/{room}/{action}` routes.
 */
export function createAnnounceRoutes(
  deps: AnnounceRouteDeps,
): Hono<{ Variables: RequestIdVariables }> {
  const routes = new Hono<{ Variables: RequestIdVariables }>();
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES });

  routes.post('/announce', limit, async (c) => {
    const body = parseBody(announceBodySchema, await c.req.json().catch(() => undefined));
    const idempotencyKey = c.req.header('Idempotency-Key') ?? body.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const earlier = deps.history.findByIdempotencyKey(idempotencyKey, deps.idempotencyWindowMs);
      if (earlier) {
        deps.logger.info({ id: earlier.id, idempotencyKey }, 'announcement replayed, not queued');
        return c.json(earlier, 200, { 'Idempotent-Replayed': 'true' });
      }
    }

    const spec = await buildSpec(deps, body, c.get('requestId'), idempotencyKey);
    const handle = deps.announcer.submit(spec);
    if (body.wait) {
      return c.json({ status: 'success', announcement: await handle.done });
    }

    return c.json(
      { id: handle.id, state: 'queued', priority: spec.priority, requestId: spec.requestId },
      202,
      { Location: `/announce/${handle.id}` },
    );
  });

  routes.get('/announce', (c) =>
    c.json(deps.history.list(parseBody(listQuerySchema, c.req.query()))),
  );

  routes.get('/announce/:id', (c) => {
    const entry = deps.history.get(c.req.param('id'));
    if (!entry) {
      throw new NotFoundError(`No announcement '${c.req.param('id')}'`);
    }

    return c.json(entry);
  });

  routes.delete('/announce/:id', (c) => {
    const id = c.req.param('id');
    const handle = deps.announcer.find(id);
    if (handle) {
      handle.cancel();
      return c.json({ id, state: 'cancelling' }, 202);
    }

    const entry = deps.history.get(id);
    if (!entry) {
      throw new NotFoundError(`No announcement '${id}'`);
    }

    if (TERMINAL.has(entry.state)) {
      throw new ConflictError(`Announcement '${id}' is already ${entry.state}`);
    }

    return c.json({ id, state: entry.state }, 202);
  });

  routes.post('/tts', limit, async (c) => {
    const body = parseBody(ttsBodySchema, await c.req.json().catch(() => undefined));
    const clip = await deps.tts.speak({
      phrase: body.ssml ?? body.text ?? '',
      voice: body.voice,
      engine: body.engine,
    });
    return c.json({
      uri: `${deps.publicBaseUrl()}${clip.uri}`,
      durationMs: clip.durationMs,
      cached: clip.cached ?? false,
      synthMs: clip.synthMs ?? 0,
      chunks: clip.chunks ?? 1,
    });
  });

  return routes;
}
