import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { withTempDir } from '../testing/with-temp-dir.ts';
import { ConfigError } from './errors.ts';
import {
  ENV_OVERRIDES,
  applyEnvOverrides,
  ensureRuntimeDirectories,
  loadSettings,
} from './load.ts';

describe('loadSettings', () => {
  it('uses defaults and resolves directories when there is no settings.json', async () => {
    await withTempDir(async (dir) => {
      const loaded = await loadSettings({ rootDir: dir });

      assert.equal(loaded.fileFound, false);
      assert.equal(loaded.settingsFile, join(dir, 'settings.json'));
      assert.deepEqual(loaded.unknownKeys, []);
      assert.equal(loaded.settings.port, 5005);
      assert.equal(loaded.settings.webroot, join(dir, 'static'));
      assert.equal(loaded.settings.presetDir, join(dir, 'presets'));
      assert.equal(loaded.settings.cacheDir, join(dir, 'cache'));
    });
  });

  it('reads JSON5 with trailing commas, keeps absolute directories and reports unknown keys', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'settings.json'),
        `{
          port: 5010,
          "remove voicerss": "abc",
          "remove auth": { username: "admin", password: "x" },
          aws: { credentials: { region: "us-east-1" }, name: "Joanna" },
          presetDir: "/srv/presets",
        }`,
      );

      const loaded = await loadSettings({ rootDir: dir });

      assert.equal(loaded.fileFound, true);
      assert.equal(loaded.settings.port, 5010);
      assert.equal(loaded.settings.presetDir, '/srv/presets');
      assert.deepEqual(loaded.settings.aws, {
        credentials: { region: 'us-east-1' },
        name: 'Joanna',
        engine: 'neural',
      });
      assert.deepEqual(loaded.unknownKeys, ['remove voicerss', 'remove auth']);
      assert.equal(loaded.settings.auth, undefined, 'renamed keys are not applied');
    });
  });

  it('lets the environment override the file and switches Polly on from AWS variables', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'settings.json'), '{ port: 5010, announceVolume: 30 }');

      const loaded = await loadSettings({
        rootDir: dir,
        env: {
          SONOS_HTTP_PORT: '6000',
          SONOS_HTTP_AUTH_USERNAME: 'admin',
          SONOS_HTTP_AUTH_PASSWORD: 'secret',
          SONOS_POLLY_VOICE: 'Matthew',
          SONOS_POLLY_ENGINE: 'standard',
          AWS_REGION: 'eu-west-1',
          AWS_ACCESS_KEY_ID: 'AKIA',
          AWS_SECRET_ACCESS_KEY: 'shh',
          LOG_LEVEL: 'debug',
          SONOS_WEBHOOK_URL: '',
        },
      });

      assert.equal(loaded.settings.port, 6000);
      assert.equal(loaded.settings.announceVolume, 30);
      assert.deepEqual(loaded.settings.auth, { username: 'admin', password: 'secret' });
      assert.deepEqual(loaded.settings.aws, {
        credentials: { region: 'eu-west-1' },
        voice: 'Matthew',
        engine: 'standard',
      });
      assert.equal(loaded.settings.logLevel, 'debug');
      assert.equal(loaded.settings.webhook, undefined, 'empty values are ignored');
      assert.ok(
        !JSON.stringify(loaded.settings).includes('shh'),
        'secrets stay in the environment',
      );
    });
  });

  it('enables Polly with defaults when only AWS credentials are present', () => {
    const raw: Record<string, unknown> = {};
    applyEnvOverrides(raw, { AWS_ACCESS_KEY_ID: 'AKIA' });
    assert.deepEqual(raw, { aws: {} });

    const untouched: Record<string, unknown> = { aws: { voice: 'Amy' } };
    applyEnvOverrides(untouched, { AWS_ACCESS_KEY_ID: 'AKIA' });
    assert.deepEqual(untouched, { aws: { voice: 'Amy' } });
  });

  it('documents every override', () => {
    assert.ok(ENV_OVERRIDES.length >= 15);
    assert.ok(ENV_OVERRIDES.every(([name, path]) => /^[A-Z_]+$/.test(name) && path.length > 0));
  });

  it('rejects invalid settings with readable issues', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'settings.json'), '{ port: 99999, auth: { username: "a" } }');

      await assert.rejects(loadSettings({ rootDir: dir }), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.issues.some((issue) => issue.startsWith('port:')));
        assert.ok(error.issues.some((issue) => issue.startsWith('auth.password:')));
        assert.match(error.message, /Invalid settings/);
        return true;
      });
    });
  });

  it('rejects unparseable or non-object files', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'settings.json'), '{ port: ');
      await assert.rejects(loadSettings({ rootDir: dir }), /Could not parse/);

      await writeFile(join(dir, 'settings.json'), '[1, 2]');
      await assert.rejects(loadSettings({ rootDir: dir }), /must contain a JSON object/);
    });
  });

  it('rejects unreadable files other than missing ones', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(loadSettings({ rootDir: dir, settingsFile: dir }), /Could not read/);
    });
  });
});

describe('ensureRuntimeDirectories', () => {
  it('creates the tts and cache directories', async () => {
    await withTempDir(async (dir) => {
      const { settings } = await loadSettings({ rootDir: dir });

      await ensureRuntimeDirectories(settings);
      await ensureRuntimeDirectories(settings);

      await access(join(dir, 'static', 'tts'));
      await access(join(dir, 'cache'));
    });
  });
});
