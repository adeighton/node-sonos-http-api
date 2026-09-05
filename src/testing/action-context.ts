import { mock } from 'node:test';

import type { ActionContext, AnnouncerLike } from '../actions/registry.ts';
import type { Announcement, AnnounceTarget } from '../announce/announce.ts';
import { settingsSchema } from '../config/schema.ts';
import type { Settings } from '../config/schema.ts';
import type { Player } from '../discovery/player.ts';
import { PresetStore } from '../presets/store.ts';
import type { Clip } from '../tts/provider.ts';
import { silentLogger } from '../logger.ts';
import { FakeSystem } from './fake-system.ts';
import { createTestPlayer } from './test-player.ts';
import type { TestPlayer } from './test-player.ts';

/** Records announcements instead of playing them. */
export class FakeAnnouncer implements AnnouncerLike {
  readonly calls: Array<{ target: AnnounceTarget; announcement: Announcement }> = [];
  readonly announce = mock.fn((target: AnnounceTarget, announcement: Announcement) => {
    this.calls.push({ target, announcement });
    return Promise.resolve();
  });
}

export interface TestActionContext {
  context: ActionContext;
  announcer: FakeAnnouncer;
  /** Every phrase spoken through the fake TTS service. */
  spoken: Array<{ phrase: string; voice: string | undefined }>;
  system: FakeSystem;
  player: Player;
  /** The test players by room name, with their recording SOAP clients. */
  rooms: Map<string, TestPlayer>;
}

export interface TestActionContextOptions {
  rooms?: string[];
  settings?: Partial<Settings>;
  presetDir?: string;
}

/** An ActionContext over a FakeSystem with one standalone test player per room. */
export function createActionContext(options: TestActionContextOptions = {}): TestActionContext {
  const system = new FakeSystem();
  const rooms = new Map<string, TestPlayer>();
  for (const [index, room] of (options.rooms ?? ['Kitchen']).entries()) {
    const created = createTestPlayer({ system, roomName: room, uuid: `RINCON_${index}` });
    system.addStandalone(created.player);
    rooms.set(room, created);
  }

  const player = system.players[0];
  if (!player) {
    throw new Error('at least one room is required');
  }

  const settings: Settings = { ...settingsSchema.parse({}), ...options.settings };
  const announcer = new FakeAnnouncer();
  const spoken: TestActionContext['spoken'] = [];
  const clip = (name: string): Clip => ({ uri: `/tts/${name}`, durationMs: 1500 });
  return {
    announcer,
    spoken,
    context: {
      tts: {
        providers: ['fake'],
        speak: (request) => {
          spoken.push({ phrase: request.phrase, voice: request.voice });
          return Promise.resolve(clip(`${encodeURIComponent(request.phrase)}.mp3`));
        },
      },
      clips: {
        get: (name) =>
          Promise.resolve({ uri: `/clips/${encodeURIComponent(name)}`, durationMs: 2500 }),
      },
      announcer,
      player,
      system,
      settings,
      presets: new PresetStore(options.presetDir ?? '/nonexistent/presets'),
      logger: silentLogger,
      publicBaseUrl: 'http://127.0.0.1:5005',
      version: '0.0.0-test',
    },
    system,
    player,
    rooms,
  };
}
