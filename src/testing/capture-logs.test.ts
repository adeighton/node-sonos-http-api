import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureLogs } from './capture-logs.ts';

describe('captureLogs', () => {
  it('captures records with level, message and extra fields', () => {
    const { logger, entries, messages } = captureLogs();

    logger.info({ room: 'Kitchen' }, 'volume changed');
    logger.debug('details');

    assert.equal(entries().length, 2);
    assert.equal(entries()[0]?.level, 30);
    assert.equal(entries()[0]?.room, 'Kitchen');
    assert.deepEqual(messages(), ['volume changed', 'details']);
  });

  it('honours the requested level', () => {
    const { logger, entries } = captureLogs('warn');

    logger.info('dropped');
    logger.warn('kept');

    assert.deepEqual(
      entries().map((entry) => entry.msg),
      ['kept'],
    );
  });
});
