import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeAnnouncer } from '../testing/action-context.ts';
import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { healthReport } from './health.ts';

describe('healthReport', () => {
  it('is 200 and ok once players are known, 503 while starting or stopping', () => {
    const system = new FakeSystem();
    const announcer = new FakeAnnouncer();
    const deps = {
      system,
      announcer,
      tts: { providers: ['polly'] },
      version: '2.1.0',
      uptimeSec: () => 12.6,
    };

    const starting = healthReport(deps);
    assert.equal(starting.httpStatus, 503);
    assert.equal(starting.body.status, 'starting');

    system.addStandalone(createTestPlayer({ system, roomName: 'Kitchen' }).player);
    const ok = healthReport(deps);
    assert.equal(ok.httpStatus, 200);
    assert.deepEqual(ok.body, {
      status: 'ok',
      version: '2.1.0',
      uptimeSec: 13,
      discovery: { players: 1, zones: 1, localEndpoint: '127.0.0.1' },
      tts: { configured: true, providers: ['polly'] },
      announcements: { queued: 0, current: undefined, draining: false },
    });

    announcer.draining = true;
    announcer.queued = 2;
    announcer.current = 'a1';
    const stopping = healthReport({ ...deps, tts: { providers: [] } });
    assert.equal(stopping.httpStatus, 503);
    assert.equal(stopping.body.status, 'stopping');
    assert.deepEqual(stopping.body.announcements, { queued: 2, current: 'a1', draining: true });
    assert.equal(stopping.body.tts.configured, false);
    assert.equal(typeof healthReport({ ...deps, uptimeSec: undefined }).body.uptimeSec, 'number');
  });
});
