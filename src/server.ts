import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { RequestListener, Server } from 'node:http';
import https from 'node:https';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import type { AddressInfo } from 'node:net';

import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';

import type { Settings } from './config/schema.ts';
import { silentLogger } from './logger.ts';
import type { Logger } from './logger.ts';

export type ServerSettings = Pick<Settings, 'port' | 'ip' | 'securePort' | 'https'>;

export interface StartServerOptions {
  app: Hono;
  settings: ServerSettings;
  logger?: Logger;
  /** Injectable for tests. */
  createHttpServer?: (listener: RequestListener) => Server;
  createHttpsServer?: (options: HttpsServerOptions, listener: RequestListener) => Server;
  readFile?: (path: string) => Promise<Buffer>;
}

export interface RunningServer {
  port: number;
  securePort: number | undefined;
  close(): Promise<void>;
}

function listen(server: Server, port: number, hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, hostname, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Long-lived /events connections would otherwise keep close() pending forever.
    server.closeAllConnections();
  });
}

/** Reads the TLS material named in settings; `undefined` when https is not usable. */
async function loadTlsOptions(
  settings: ServerSettings,
  read: (path: string) => Promise<Buffer>,
  logger: Logger,
): Promise<HttpsServerOptions | undefined> {
  const tls = settings.https;
  if (!tls) {
    return undefined;
  }

  if (tls.pfx) {
    return { pfx: await read(tls.pfx), passphrase: tls.passphrase };
  }

  if (tls.key && tls.cert) {
    return { key: await read(tls.key), cert: await read(tls.cert) };
  }

  logger.warn('https is configured but needs either pfx or both key and cert; not starting https');
  return undefined;
}

/** Starts the HTTP listener (and the HTTPS one when configured) for the app. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const logger = options.logger ?? silentLogger;
  const createHttpServer = options.createHttpServer ?? ((listener) => http.createServer(listener));
  const createHttpsServer =
    options.createHttpsServer ?? ((tls, listener) => https.createServer(tls, listener));
  const handle = getRequestListener(options.app.fetch);
  // Node expects a void listener; the adaptor handles its own errors.
  const listener: RequestListener = (incoming, outgoing) => {
    void handle(incoming, outgoing);
  };

  const servers: Server[] = [];
  const httpServer = createHttpServer(listener);
  servers.push(httpServer);
  const port = await listen(httpServer, options.settings.port, options.settings.ip);
  logger.info({ port, ip: options.settings.ip }, 'http listening');

  let securePort: number | undefined;
  const tls = await loadTlsOptions(options.settings, options.readFile ?? readFile, logger);
  if (tls) {
    const httpsServer = createHttpsServer(tls, listener);
    servers.push(httpsServer);
    securePort = await listen(httpsServer, options.settings.securePort, options.settings.ip);
    logger.info({ port: securePort, ip: options.settings.ip }, 'https listening');
  }

  return {
    port,
    securePort,
    close: async () => {
      await Promise.all(servers.map((server) => closeServer(server)));
    },
  };
}
