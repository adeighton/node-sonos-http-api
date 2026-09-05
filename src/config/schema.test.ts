import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SETTINGS_KEYS, settingsSchema } from './schema.ts';

describe('settingsSchema', () => {
  it('fills in the defaults', () => {
    const settings = settingsSchema.parse({});

    assert.equal(settings.port, 5005);
    assert.equal(settings.ip, '0.0.0.0');
    assert.equal(settings.securePort, 5006);
    assert.equal(settings.announceVolume, 40);
    assert.equal(settings.webroot, 'static');
    assert.equal(settings.presetDir, 'presets');
    assert.equal(settings.cacheDir, 'cache');
    assert.equal(settings.webhookType, 'type');
    assert.equal(settings.webhookData, 'data');
    assert.deepEqual(settings.library, { randomQueueLimit: 50 });
    assert.equal(settings.logLevel, 'info');
    assert.equal(settings.logFormat, 'pretty');
    assert.equal(settings.aws, undefined);
    assert.equal(settings.auth, undefined);
  });

  it('coerces numeric strings (environment values) and validates ranges', () => {
    const settings = settingsSchema.parse({ port: '5010', announceVolume: '55' });
    assert.equal(settings.port, 5010);
    assert.equal(settings.announceVolume, 55);

    assert.throws(() => settingsSchema.parse({ port: 70000 }));
    assert.throws(() => settingsSchema.parse({ announceVolume: 101 }));
    assert.throws(() => settingsSchema.parse({ webhook: 'not a url' }));
    assert.throws(() => settingsSchema.parse({ logLevel: 'loud' }));
  });

  it('requires both halves of auth and spotify', () => {
    assert.throws(() => settingsSchema.parse({ auth: { username: 'admin' } }));
    assert.throws(() => settingsSchema.parse({ spotify: { clientId: 'x' } }));
    assert.deepEqual(settingsSchema.parse({ auth: { username: 'a', password: 'b' } }).auth, {
      username: 'a',
      password: 'b',
    });
  });

  it('defaults the Polly engine to neural and accepts the legacy voice name key', () => {
    const settings = settingsSchema.parse({ aws: { name: 'Joanna' } });
    assert.equal(settings.aws?.engine, 'neural');
    assert.equal(settings.aws?.name, 'Joanna');
    assert.throws(() => settingsSchema.parse({ aws: { engine: 'turbo' } }));
  });

  it('drops unknown keys and exposes the known key list', () => {
    const settings = settingsSchema.parse({ 'remove auth': { username: 'x' }, port: 1 });
    assert.equal('remove auth' in settings, false);
    assert.ok(SETTINGS_KEYS.includes('port'));
    assert.ok(SETTINGS_KEYS.includes('aws'));
  });
});
