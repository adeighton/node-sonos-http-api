import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureLogs } from './testing/capture-logs.ts';
import { LOG_LEVELS, createLogger, silentLogger } from './logger.ts';

describe('createLogger', () => {
  it('redacts secrets wherever they appear in logged objects', () => {
    const { logger, text } = captureLogs();

    logger.info(
      {
        settings: {
          auth: { username: 'admin', password: 'hunter2' },
          aws: { credentials: { accessKeyId: 'AKIAXXXX', secretAccessKey: 'topsecret' } },
          spotify: { clientId: 'id', clientSecret: 'spotsecret' },
        },
      },
      'settings loaded',
    );
    logger.warn({ aws: { credentials: { secretAccessKey: 'again' } } }, 'nested');

    const output = text();
    assert.ok(output.includes('admin'), 'usernames are not secret');
    assert.ok(output.includes('[redacted]'));
    for (const secret of ['hunter2', 'AKIAXXXX', 'topsecret', 'spotsecret', 'again']) {
      assert.ok(!output.includes(secret), `${secret} leaked into the log`);
    }
  });

  it('exposes the level list used by configuration', () => {
    assert.ok(LOG_LEVELS.includes('info'));
    assert.ok(LOG_LEVELS.includes('silent'));
  });

  it('creates json and pretty loggers without a destination', () => {
    const json = createLogger({ format: 'json', level: 'silent' });
    const prettyLogger = createLogger({ level: 'silent' });

    assert.equal(json.level, 'silent');
    assert.equal(prettyLogger.level, 'silent');
  });

  it('provides a silent logger for library defaults', () => {
    assert.equal(silentLogger.level, 'silent');
    assert.doesNotThrow(() => silentLogger.error('ignored'));
  });
});
