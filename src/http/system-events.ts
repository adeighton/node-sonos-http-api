import type { ActionSystem } from '../actions/registry.ts';
import type { EventHub } from './events.ts';
import { buildEventBody } from './webhook.ts';
import type { WebhookNotifier, WebhookSettings } from './webhook.ts';

export interface SystemEventsDeps {
  system: Pick<ActionSystem, 'on' | 'off'>;
  settings: WebhookSettings;
  hub: EventHub;
  webhook?: WebhookNotifier | undefined;
}

/** The system events forwarded to `/events` clients and the webhook, in the original wire format. */
export const FORWARDED_EVENTS = [
  'transport-state',
  'topology-change',
  'volume-change',
  'mute-change',
] as const;

/** Forwards player/topology events to SSE clients and the webhook; returns an unsubscribe function. */
export function wireSystemEvents(deps: SystemEventsDeps): () => void {
  const publish = (type: string, data: unknown): void => {
    const body = buildEventBody(deps.settings, type, data);
    deps.hub.broadcast(body);
    void deps.webhook?.(body);
  };

  const onTransportState = (player: unknown): void => publish('transport-state', player);
  const onTopologyChange = (zones: unknown): void => publish('topology-change', zones);
  const onVolumeChange = (change: unknown): void => publish('volume-change', change);
  const onMuteChange = (change: unknown): void => publish('mute-change', change);

  deps.system.on('transport-state', onTransportState);
  deps.system.on('topology-change', onTopologyChange);
  deps.system.on('volume-change', onVolumeChange);
  deps.system.on('mute-change', onMuteChange);

  return () => {
    deps.system.off('transport-state', onTransportState);
    deps.system.off('topology-change', onTopologyChange);
    deps.system.off('volume-change', onVolumeChange);
    deps.system.off('mute-change', onMuteChange);
  };
}
