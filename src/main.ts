/**
 * Entry point: loads settings, wires the discovery layer to the HTTP app and handles signals.
 * Everything it composes is unit-tested on its own; this file stays thin on purpose.
 */
import { join, resolve } from 'node:path';

import pkg from '../package.json' with { type: 'json' };
import { createActionRegistry } from './actions/index.ts';
import { Announcer } from './announce/announce.ts';
import { createApp } from './app.ts';
import { ConfigError } from './config/errors.ts';
import { ensureRuntimeDirectories, loadSettings } from './config/load.ts';
import { SonosSystem } from './discovery/sonos-system.ts';
import { EventHub } from './http/events.ts';
import { wireSystemEvents } from './http/system-events.ts';
import { createWebhookNotifier } from './http/webhook.ts';
import { createLogger } from './logger.ts';
import { PresetStore } from './presets/store.ts';
import { startServer } from './server.ts';
import { createClipLibrary } from './tts/clips.ts';
import { createTtsService } from './tts/index.ts';

const SHUTDOWN_GRACE_MS = 5000;

async function main(): Promise<void> {
  const rootDir = resolve(import.meta.dirname, '..');
  const { settings, settingsFile, fileFound, unknownKeys } = await loadSettings({
    rootDir,
    env: process.env,
  });
  const logger = createLogger({ level: settings.logLevel, format: settings.logFormat });
  logger.info({ version: pkg.version, node: process.version, settingsFile, fileFound }, 'starting');
  if (unknownKeys.length > 0) {
    logger.warn(
      { unknownKeys },
      'settings.json has keys this version does not use (retired providers or typos); they are ignored',
    );
  }

  await ensureRuntimeDirectories(settings);

  const presets = new PresetStore(settings.presetDir, { logger });
  await presets.load();
  presets.watch();

  const system = new SonosSystem(
    {
      household: settings.household,
      discoveryHosts: settings.discoveryHosts,
      soundcloudClientId: settings.soundcloud,
    },
    { logger },
  );
  const hub = new EventHub({ logger });
  const unwire = wireSystemEvents({
    system,
    settings,
    hub,
    webhook: createWebhookNotifier({ settings, logger }),
  });

  const app = createApp({
    system,
    settings,
    registry: createActionRegistry({
      cacheDir: settings.cacheDir,
      spotify: settings.spotify,
      randomQueueLimit: settings.library.randomQueueLimit,
      logger,
    }),
    presets,
    tts: createTtsService(settings, { logger }),
    clips: createClipLibrary({ dir: join(settings.webroot, 'clips') }),
    announcer: new Announcer({ system, logger }),
    hub,
    logger,
    version: pkg.version,
    publicBaseUrl: () => `http://${system.localEndpoint}:${settings.port}`,
  });
  const server = await startServer({ app, settings, logger });

  system.once('initialized', () => {
    logger.info(
      {
        players: system.players.map((player) => player.roomName),
        zones: system.zones.length,
        localEndpoint: system.localEndpoint,
      },
      'Sonos system discovered',
    );
  });
  system.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    unwire();
    hub.close();
    presets.close();
    await server.close();
    await system.dispose();
    logger.info('bye');
    process.exitCode = 0;
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exitCode = 1;
});
