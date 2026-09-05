import type { ActionContext } from '../actions/registry.ts';
import { settingsSchema } from '../config/schema.ts';
import type { Settings } from '../config/schema.ts';
import type { Player } from '../discovery/player.ts';
import { PresetStore } from '../presets/store.ts';
import { silentLogger } from '../logger.ts';
import { FakeSystem } from './fake-system.ts';
import { createTestPlayer } from './test-player.ts';
import type { TestPlayer } from './test-player.ts';

export interface TestActionContext {
  context: ActionContext;
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
  return {
    context: {
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
