import assert from 'node:assert/strict';

import type { HealthReport } from '../../src/http/health.ts';
import { describeLive } from './boot.ts';

describeLive('health (live)', ({ it }) => {
  it('reports the discovered system, text-to-speech and the announcement queue', async ({
    harness,
  }) => {
    const response = await harness.get('/health');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const health = response.body as HealthReport;
    assert.equal(health.status, 'ok');
    assert.ok(health.discovery.players > 0);
    assert.ok(health.discovery.zones > 0);
    assert.match(health.discovery.localEndpoint, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(health.tts.configured, Boolean(process.env.AWS_ACCESS_KEY_ID));
    assert.equal(health.announcements.queued, 0);
    assert.equal(health.announcements.current, undefined);
    assert.equal(health.announcements.draining, false);
    assert.ok(health.uptimeSec >= 0);
  });

  it('turns 503 while the server drains for shutdown', async ({ harness, scheduler }, t) => {
    if (!scheduler) {
      t.skip('needs the test-owned server (not SONOS_LIVE_API)');
      return;
    }

    // Last test in this file: the stack is closed right after it anyway.
    scheduler.beginShutdown();
    const response = await harness.get('/health');
    assert.equal(response.status, 503);
    assert.equal((response.body as HealthReport).status, 'stopping');
    const refused = await harness.request('/announce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clip: 'TacoBellBong.mp3', target: 'all' }),
    });
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('Retry-After'), '10');
  });
});
