import type { ActionSystem } from '../actions/registry.ts';
import type { AnnouncementTransition } from '../announce/types.ts';
import type { EventHub } from './events.ts';
import { buildEventBody } from './webhook.ts';
import type { WebhookNotifier, WebhookSettings } from './webhook.ts';

export interface TransitionSource {
  on(event: 'transition', listener: (transition: AnnouncementTransition) => void): unknown;
  off(event: 'transition', listener: (transition: AnnouncementTransition) => void): unknown;
}

export interface SystemEventsDeps {
  system: Pick<ActionSystem, 'on' | 'off'>;
  /** Its transitions go out as `announcement` events. */
  scheduler?: TransitionSource | undefined;
  settings: WebhookSettings;
  hub: EventHub;
  webhook?: WebhookNotifier | undefined;
}

/** The events forwarded to `/events` clients and the webhook, in the original wire format. */
export const FORWARDED_EVENTS = [
  'transport-state',
  'topology-change',
  'volume-change',
  'mute-change',
  'announcement',
] as const;

/**
 * Forwards player/topology events and announcement transitions to SSE clients and the webhook;
 * returns an unsubscribe function.
 */
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
  const onTransition = (transition: AnnouncementTransition): void =>
    publish('announcement', transition);

  deps.system.on('transport-state', onTransportState);
  deps.system.on('topology-change', onTopologyChange);
  deps.system.on('volume-change', onVolumeChange);
  deps.system.on('mute-change', onMuteChange);
  deps.scheduler?.on('transition', onTransition);

  return () => {
    deps.system.off('transport-state', onTransportState);
    deps.system.off('topology-change', onTopologyChange);
    deps.system.off('volume-change', onVolumeChange);
    deps.system.off('mute-change', onMuteChange);
    deps.scheduler?.off('transition', onTransition);
  };
}
