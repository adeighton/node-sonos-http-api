import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { FakeSystem } from '../testing/fake-system.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { EventHub } from './events.ts';
import type { SseClient } from './events.ts';
import { FORWARDED_EVENTS, wireSystemEvents } from './system-events.ts';

describe('wireSystemEvents', () => {
  it('forwards the four event types to SSE clients and the webhook in the legacy format', async () => {
    const system = new FakeSystem();
    const { player } = createTestPlayer({ system, roomName: 'Kitchen' });
    system.addStandalone(player);
    const hub = new EventHub();
    const received: string[] = [];
    const client: SseClient = {
      writeEvent: (data) => void received.push(data),
      writeComment: () => undefined,
    };
    hub.add(client);
    const webhook = mock.fn((_body: string) => Promise.resolve());

    const unwire = wireSystemEvents({
      system,
      settings: { webhookType: 'type', webhookData: 'data' },
      hub,
      webhook,
    });

    system.emit('volume-change', {
      uuid: 'u',
      previousVolume: 1,
      newVolume: 2,
      roomName: 'Kitchen',
    });
    system.emit('mute-change', {
      uuid: 'u',
      previousMute: false,
      newMute: true,
      roomName: 'Kitchen',
    });
    system.emit('transport-state', player);
    system.emit('topology-change', system.zones);
    system.emit('group-volume', { uuid: 'u', oldVolume: 1, newVolume: 2, roomName: 'Kitchen' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 4);
    assert.deepEqual(JSON.parse(received[0] ?? ''), {
      type: 'volume-change',
      data: { uuid: 'u', previousVolume: 1, newVolume: 2, roomName: 'Kitchen' },
    });
    const transport = JSON.parse(received[2] ?? '') as {
      type: string;
      data: { roomName: string; state: unknown };
    };
    assert.equal(transport.type, 'transport-state');
    assert.equal(transport.data.roomName, 'Kitchen', 'players serialize through toJSON');
    const topology = JSON.parse(received[3] ?? '') as {
      data: Array<{ coordinator: { roomName: string } }>;
    };
    assert.equal(topology.data[0]?.coordinator.roomName, 'Kitchen');
    assert.equal(webhook.mock.callCount(), 4);
    assert.equal(webhook.mock.calls[1]?.arguments[0], received[1]);

    unwire();
    system.emit('volume-change', {
      uuid: 'u',
      previousVolume: 2,
      newVolume: 3,
      roomName: 'Kitchen',
    });
    assert.equal(received.length, 4, 'nothing is forwarded after unwiring');
    assert.deepEqual(
      [...FORWARDED_EVENTS],
      ['transport-state', 'topology-change', 'volume-change', 'mute-change'],
    );
  });

  it('works without a webhook', () => {
    const system = new FakeSystem();
    const hub = new EventHub();
    wireSystemEvents({ system, settings: { webhookType: 'type', webhookData: 'data' }, hub });

    assert.doesNotThrow(() =>
      system.emit('mute-change', { uuid: 'u', previousMute: false, newMute: true, roomName: 'K' }),
    );
  });
});
