import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { captureLogs } from '../testing/capture-logs.ts';
import { withTempDir } from '../testing/with-temp-dir.ts';
import { PresetStore } from './store.ts';
import type { WatchDirectory } from './store.ts';

async function writePresets(dir: string): Promise<void> {
  await writeFile(join(dir, 'doorbell.json'), '{ players: [{ roomName: "Hall", volume: 60 }], pauseOthers: false, }');
  await writeFile(join(dir, 'library.json'), '{"players":[{"roomName":"Library","volume":20}]}');
  await writeFile(join(dir, 'broken.json'), '{ players: [] }');
  await writeFile(join(dir, 'notes.txt'), 'not a preset');
  await writeFile(join(dir, '.hidden.json'), '{"players":[{"roomName":"x"}]}');
  await mkdir(join(dir, 'folder.json'));
}

describe('PresetStore', () => {
  it('loads valid *.json presets, skipping invalid, hidden and non-json entries', async () => {
    await withTempDir(async (dir) => {
      await writePresets(dir);
      const { logger, entries } = captureLogs();
      const store = new PresetStore(dir, { logger });

      await store.load();

      assert.deepEqual(store.names(), ['doorbell', 'library']);
      assert.equal(store.get('doorbell')?.players[0]?.volume, 60);
      assert.equal(store.get('missing'), undefined);
      const warnings = entries().filter((entry) => entry.msg === 'skipping invalid preset file');
      assert.equal(warnings.length, 2, 'broken.json and the folder are both skipped');
    });
  });

  it('yields no presets and warns when the directory is missing', async () => {
    const { logger, messages } = captureLogs();
    const store = new PresetStore('/nonexistent/presets', { logger });

    await store.load();

    assert.deepEqual(store.names(), []);
    assert.ok(messages().includes('could not read the preset directory'));
  });

  it('shares one in-flight load', async () => {
    await withTempDir(async (dir) => {
      await writePresets(dir);
      const store = new PresetStore(dir);

      const first = store.load();
      const second = store.load();
      assert.equal(first, second);
      await first;

      assert.notEqual(store.load(), first, 'a new load starts once the previous finished');
    });
  });

  describe('watching', () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ['setTimeout'] });
    });
    afterEach(() => {
      mock.timers.reset();
    });

    it('reloads after a debounced directory change and stops on close', async () => {
      await withTempDir(async (dir) => {
        await writePresets(dir);
        let onChange: (() => void) | undefined;
        const close = mock.fn(() => undefined);
        const watch: WatchDirectory = (_dir, handler) => {
          onChange = handler;
          return { close };
        };
        const store = new PresetStore(dir, { watch, debounceMs: 200 });
        await store.load();
        store.watch();
        store.watch();
        assert.ok(onChange);

        await rm(join(dir, 'library.json'));
        onChange();
        onChange();
        mock.timers.tick(199);
        assert.deepEqual(store.names(), ['doorbell', 'library'], 'not reloaded before the debounce');
        mock.timers.tick(1);
        await store.load(); // joins the reload the timer started

        assert.deepEqual(store.names(), ['doorbell']);

        store.close();
        assert.equal(close.mock.callCount(), 1);
        onChange();
        mock.timers.tick(200);
        store.close();
      });
    });

    it('logs when the directory cannot be watched', () => {
      const { logger, messages } = captureLogs();
      const store = new PresetStore('/nonexistent', {
        logger,
        watch: () => {
          throw new Error('ENOENT');
        },
      });

      store.watch();

      assert.ok(messages().some((message) => message.includes('could not watch')));
    });
  });

  it('watches the real filesystem by default', async () => {
    await withTempDir(async (dir) => {
      await writePresets(dir);
      const store = new PresetStore(dir, { debounceMs: 20 });
      await store.load();
      store.watch();

      await writeFile(join(dir, 'garden.json'), '{"players":[{"roomName":"Garden"}]}');
      // Generous: the loop exits the moment the watcher fires, so a long deadline costs nothing
      // in the happy path and keeps fs.watch latency under parallel test load from failing here.
      const deadline = Date.now() + 30_000;
      while (!store.names().includes('garden') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      store.close();
      assert.ok(store.names().includes('garden'));
    });
  });
});
