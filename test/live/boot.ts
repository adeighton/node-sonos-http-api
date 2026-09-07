/**
 * Boots the real server against the real Sonos system for the live tests, and skips every test
 * cleanly when that is not possible (SONOS_LIVE unset, or no system found in time).
 *
 *   SONOS_LIVE=1 SONOS_LIVE_ROOMS="1. Dining Room,1. Kitchen" npm run test:live
 *
 * Every test is wrapped in a whole-house check: whatever it did, the grouping, volumes, mute and
 * play modes of every room must be back afterwards, or the test fails. Transport and playback
 * state are compared only for the test rooms, since music elsewhere keeps changing track.
 */
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import pkg from '../../package.json' with { type: 'json' };
import { createActionRegistry } from '../../src/actions/index.ts';
import { Announcer } from '../../src/announce/announce.ts';
import { createApp } from '../../src/app.ts';
import { ensureRuntimeDirectories, loadSettings } from '../../src/config/load.ts';
import { SonosSystem } from '../../src/discovery/sonos-system.ts';
import { EventHub } from '../../src/http/events.ts';
import { createLogger } from '../../src/logger.ts';
import { PresetStore } from '../../src/presets/store.ts';
import { startServer } from '../../src/server.ts';
import { LiveHarness, liveGate, parseRooms } from '../../src/testing/live-harness.ts';
import type { RoomField } from '../../src/testing/live-harness.ts';
import { createClipLibrary } from '../../src/tts/clips.ts';
import { createTtsService } from '../../src/tts/index.ts';

const DISCOVERY_TIMEOUT_MS = 15_000;
const STABILIZE_TIMEOUT_MS = 15_000;
const SETTLE_MS = 4000;
/** What the rest of the house is held to; tracks change and TVs get switched on regardless. */
const HOUSE_IGNORE: RoomField[] = ['uri', 'playbackState'];

export interface LiveStack {
  harness: LiveHarness;
  baseUrl: string;
  /** Absent when testing a server that is already running (`SONOS_LIVE_API`). */
  system?: SonosSystem;
  close(): Promise<void>;
}

/** Waits for the whole house to report its state, then returns the ready stack. */
async function settled(harness: LiveHarness, rest: Omit<LiveStack, 'harness'>): Promise<LiveStack> {
  // Right after subscribing, every player sends its full state; a snapshot taken before that
  // would compare empty volumes and tracks against real ones.
  await harness.waitUntilStable(await everyRoom(harness), {
    timeoutMs: STABILIZE_TIMEOUT_MS,
    consecutive: 3,
  });
  return { harness, ...rest };
}

/** Targets a server that is already running, e.g. the Pi, instead of starting one. */
async function attachLive(baseUrl: string): Promise<LiveStack | undefined> {
  const harness = new LiveHarness({
    fetch: (url, init) => fetch(new URL(url, baseUrl), init),
    rooms: parseRooms(process.env.SONOS_LIVE_ROOMS),
    settleMs: SETTLE_MS,
    scratchRoom: process.env.SONOS_LIVE_SCRATCH_ROOM,
  });
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const zones = await harness.get('/zones').catch(() => undefined);
    if (zones?.status === 200) {
      return settled(harness, { baseUrl, close: () => Promise.resolve() });
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return undefined;
}

/** Starts everything main.ts starts, on a random port, and waits for discovery. */
export async function bootLive(): Promise<LiveStack | undefined> {
  if (process.env.SONOS_LIVE_API) {
    return attachLive(process.env.SONOS_LIVE_API);
  }

  const rootDir = resolve(import.meta.dirname, '../..');
  const { settings } = await loadSettings({ rootDir, env: process.env });
  const logger = createLogger({ level: process.env.LIVE_LOG_LEVEL === 'debug' ? 'debug' : 'warn' });
  await ensureRuntimeDirectories(settings);

  const presets = new PresetStore(settings.presetDir, { logger });
  await presets.load();
  const system = new SonosSystem(
    {
      household: settings.household,
      discoveryHosts: settings.discoveryHosts,
      soundcloudClientId: settings.soundcloud,
    },
    { logger },
  );
  const hub = new EventHub({ logger });
  let port = 0;
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
    version: `${pkg.version}-live`,
    publicBaseUrl: () => `http://${system.localEndpoint}:${port}`,
  });
  const server = await startServer({ app, settings: { ...settings, port: 0 }, logger });
  port = server.port;

  const discovered = await new Promise<boolean>((resolveFound) => {
    const timer = setTimeout(() => resolveFound(false), DISCOVERY_TIMEOUT_MS);
    system.once('initialized', () => {
      clearTimeout(timer);
      resolveFound(true);
    });
    system.start();
  });

  const close = async (): Promise<void> => {
    hub.close();
    presets.close();
    await server.close();
    await system.dispose();
  };

  if (!discovered) {
    await close();
    return undefined;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const harness = new LiveHarness({
    fetch: (url, init) => fetch(new URL(url, baseUrl), init),
    rooms: parseRooms(process.env.SONOS_LIVE_ROOMS),
    settleMs: SETTLE_MS,
    scratchRoom: process.env.SONOS_LIVE_SCRATCH_ROOM,
  });
  return settled(harness, { baseUrl, system, close });
}

export type LiveTest = (stack: LiveStack, t: TestContext) => Promise<void>;

export interface LiveSuite {
  /** A test that runs only when the live stack is up; otherwise it is skipped with the reason. */
  it: (name: string, fn: LiveTest) => void;
}

async function everyRoom(harness: LiveHarness): Promise<string[]> {
  return (await harness.zones()).flatMap((zone) => zone.members.map((member) => member.roomName));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * `describe` for live tests. Without `SONOS_LIVE=1` every test is registered as skipped; with it,
 * the real stack boots once in `before`, every test receives it, and after each test the house
 * must be back the way it was.
 */
export function describeLive(name: string, define: (suite: LiveSuite) => void): void {
  const gate = liveGate(process.env);
  if (!gate.enabled) {
    describe(name, () => {
      define({
        it: (testName) => {
          void it(testName, { skip: gate.reason }, () => {});
        },
      });
    });
    return;
  }

  describe(name, () => {
    let stack: LiveStack | undefined;
    let reason = 'no Sonos system was discovered within 15 s';

    before(async () => {
      stack = await bootLive();
      if (stack) {
        reason = '';
      }
    });
    after(async () => {
      await stack?.close();
    });

    define({
      it: (testName, fn) => {
        void it(testName, async (t) => {
          if (!stack) {
            t.skip(reason);
            return;
          }

          const { harness } = stack;
          const house = await harness.snapshot(await everyRoom(harness));
          let failure: Error | undefined;
          try {
            await fn(stack, t);
          } catch (error) {
            failure = asError(error);
          }

          try {
            await harness.assertRestored(house, { ignore: HOUSE_IGNORE });
          } catch (error) {
            // The test's own failure is the more useful one to report.
            if (failure === undefined) {
              throw asError(error);
            }

            t.diagnostic(`after the failure, ${asError(error).message}`);
          }

          if (failure !== undefined) {
            throw failure;
          }
        });
      },
    });
  });
}
