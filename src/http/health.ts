import type { ActionSystem, AnnouncerLike } from '../actions/registry.ts';
import type { TtsService } from '../tts/index.ts';

export interface HealthDeps {
  system: Pick<ActionSystem, 'zones' | 'players' | 'localEndpoint'>;
  announcer: Pick<AnnouncerLike, 'queued' | 'current' | 'draining'>;
  tts: Pick<TtsService, 'providers'>;
  version: string;
  /** `process.uptime()` in production; injectable for tests. */
  uptimeSec?: (() => number) | undefined;
}

export interface HealthReport {
  status: 'ok' | 'starting' | 'stopping';
  version: string;
  uptimeSec: number;
  discovery: { players: number; zones: number; localEndpoint: string };
  tts: { configured: boolean; providers: string[] };
  announcements: { queued: number; current: string | undefined; draining: boolean };
}

/**
 * What a monitor or a load balancer wants to know, unauthenticated: 200 once the Sonos system
 * is known and the server is not shutting down, 503 otherwise (with the same body).
 */
export function healthReport(deps: HealthDeps): { httpStatus: 200 | 503; body: HealthReport } {
  const draining = deps.announcer.draining;
  const discovered = deps.system.zones.length > 0;
  const body: HealthReport = {
    status: draining ? 'stopping' : discovered ? 'ok' : 'starting',
    version: deps.version,
    uptimeSec: Math.round(deps.uptimeSec?.() ?? process.uptime()),
    discovery: {
      players: deps.system.players.length,
      zones: deps.system.zones.length,
      localEndpoint: deps.system.localEndpoint,
    },
    tts: { configured: deps.tts.providers.length > 0, providers: [...deps.tts.providers] },
    announcements: {
      queued: deps.announcer.queued,
      current: deps.announcer.current,
      draining,
    },
  };
  return { httpStatus: body.status === 'ok' ? 200 : 503, body };
}
