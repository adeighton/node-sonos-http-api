import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { TrieRouter } from 'hono/router/trie-router';
import { streamSSE } from 'hono/streaming';

import type { ActionRegistry, ActionSystem, AnnouncerLike } from './actions/registry.ts';
import type { Settings } from './config/schema.ts';
import { decodePathSegments, resolveRequest, runAction } from './http/dispatch.ts';
import { errorBody, statusForError } from './http/errors.ts';
import type { EventHub } from './http/events.ts';
import { renderIndexHtml } from './http/index-page.ts';
import type { Logger } from './logger.ts';
import type { PresetStore } from './presets/store.ts';
import type { ClipLibrary } from './tts/clips.ts';
import type { TtsService } from './tts/index.ts';

export interface AppDeps {
  system: ActionSystem;
  settings: Settings;
  registry: ActionRegistry;
  presets: PresetStore;
  tts: TtsService;
  clips: ClipLibrary;
  announcer: AnnouncerLike;
  hub: EventHub;
  logger: Logger;
  version: string;
  /** Computed per request: the local endpoint is only known once discovery has run. */
  publicBaseUrl: () => string;
}

/** Paths under the webroot that players fetch without authentication. */
const PUBLIC_STATIC_PATHS = ['/tts/*', '/clips/*', '/sonos-icon.png'];

export function createApp(deps: AppDeps): Hono {
  const { settings, logger } = deps;
  // TrieRouter, not the default SmartRouter. Hono decodes the path with `decodeURI` before
  // routing, and SmartRouter settles on RegExpRouter, whose wildcard compiles to `.*` — a pattern
  // that in JavaScript never matches a line terminator, so any multi-line say phrase missed every
  // route and fell through to a bare 404. SmartRouter cannot recover: it chooses on the first
  // request and only reconsiders if registration throws, which RegExpRouter does not do here.
  // TrieRouter is the router Hono documents as supporting every pattern, and at this app's
  // handful of routes and request rate its extra cost is immaterial.
  const app = new Hono({ router: new TrieRouter() });

  app.use('*', async (c, next) => {
    await next();
    logger.debug(
      { method: c.req.method, path: c.req.path, status: c.res.status },
      'request handled',
    );
  });

  // Media the Sonos players fetch: deliberately outside basic auth.
  for (const path of PUBLIC_STATIC_PATHS) {
    app.use(path, serveStatic({ root: settings.webroot }));
  }
  app.get('/tts/*', (c) => c.json(errorBody(new Error('No such clip')), 404));
  app.get('/clips/*', (c) => c.json(errorBody(new Error('No such clip')), 404));

  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] }));

  if (settings.auth) {
    app.use(
      '*',
      basicAuth({
        username: settings.auth.username,
        password: settings.auth.password,
        realm: 'Access Denied',
      }),
    );
  }

  app.get('/', (c) =>
    c.html(
      renderIndexHtml({
        registry: deps.registry,
        version: deps.version,
        roomNames: deps.system.players.map((player) => player.roomName),
      }),
    ),
  );
  app.get('/favicon.ico', (c) => c.body(null, 204));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const client = {
        writeEvent: (data: string) => stream.writeSSE({ data }),
        writeComment: (text: string) => stream.write(`: ${text}\n\n`).then(() => undefined),
      };
      deps.hub.add(client);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      deps.hub.remove(client);
    }),
  );

  app.get('/*', async (c) => {
    const segments = decodePathSegments(new URL(c.req.url).pathname);
    const { player, action, values } = resolveRequest(deps.system, segments);
    const result = await runAction(
      deps.registry,
      {
        player,
        system: deps.system,
        settings,
        presets: deps.presets,
        tts: deps.tts,
        clips: deps.clips,
        announcer: deps.announcer,
        logger,
        publicBaseUrl: deps.publicBaseUrl(),
        version: deps.version,
      },
      action,
      values,
    );
    return c.json(result);
  });

  app.all('/*', (c) => {
    c.header('Allow', 'GET');
    return c.json(errorBody(new Error(`Method ${c.req.method} not allowed`)), 405);
  });

  app.onError((error, c) => {
    const status = statusForError(error);
    if (error instanceof HTTPException) {
      // Hono middleware (basic auth) answers through exceptions; keep its headers, use our body.
      const headers = Object.fromEntries(error.getResponse().headers.entries());
      return c.json(errorBody(error), error.status, headers);
    }

    logger[status >= 500 ? 'error' : 'warn'](
      { err: error, method: c.req.method, path: c.req.path, status },
      'request failed',
    );
    return c.json(errorBody(error), status);
  });

  return app;
}
