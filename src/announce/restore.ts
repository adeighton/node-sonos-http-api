import type { Player, Zone } from '../discovery/player.ts';
import { withTransientRetry } from '../discovery/retry.ts';
import type { Preset } from '../discovery/types.ts';
import { errorMessage } from '../http/errors.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { mapLimit } from '../util/parallel.ts';
import type { AnnouncementPlan } from './plan.ts';
import type { AnnounceSystem } from './types.ts';
import { waitForTopology } from './wait.ts';

const RADIO_OR_LINE_IN_PREFIXES = [
  'x-sonosapi-stream:',
  'x-sonosapi-radio:',
  'pndrradio:',
  'x-sonosapi-hls:',
  'x-rincon-stream:',
  'x-sonos-htastream:',
  'x-sonosprog-http:',
  'x-rincon-mp3radio:',
];

/** Streams have no track position to restore. */
export function isRadioOrLineIn(uri: string): boolean {
  return RADIO_OR_LINE_IN_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

/**
 * Transports a player refuses to be set back to: nothing at all (an idle player after boot) and
 * sessions pushed by another app, such as AirPlay, Spotify Connect or a voice assistant
 * (`x-sonos-vli:`), which end when the announcement takes over.
 */
export function isRestorableUri(uri: string): boolean {
  return uri !== '' && !uri.startsWith('x-sonos-vli:');
}

/** A player following another player's group (`x-rincon:<uuid>`) cannot seek either. */
export function isGroupLink(uri: string): boolean {
  return uri.startsWith('x-rincon:');
}

/**
 * Whether a queue position is worth restoring: not for streams or group links, and not when the
 * queue was empty (Sonos reports track 0), since seeking there only fails.
 */
export function hasQueuePosition(uri: string, trackNo: number): boolean {
  return !isRadioOrLineIn(uri) && !isGroupLink(uri) && trackNo > 0;
}

/**
 * One thing to put back after an announcement. `room` names the player the step acts on.
 * - `zone`: re-form a group under its coordinator and resume its transport (a whole-zone preset).
 * - `rejoin`: send a player back to the group it left; `groupOf` are the uuids of the players
 *   that stayed, whoever coordinates them by then.
 * - `resume`: play again on a group that was only paused by `pauseOthers`.
 */
export type RestoreStep =
  | { kind: 'zone'; room: string; preset: Preset }
  | { kind: 'rejoin'; room: string; volume: number; groupOf: string[] }
  | { kind: 'resume'; room: string };

export interface RestorePlan {
  /** In execution order: every other step first, the announcement coordinator's last. */
  steps: RestoreStep[];
}

function transportBackup(coordinator: Player): Partial<Preset> {
  const state = coordinator.state;
  if (!isRestorableUri(coordinator.avTransportUri)) {
    // Leave the player idle on its own queue instead of on the announcement clip.
    return {
      state: 'STOPPED',
      uri: `x-rincon-queue:${coordinator.uuid}#0`,
      metadata: '',
      playMode: { repeat: state.playMode.repeat },
    };
  }

  const preset: Partial<Preset> = {
    state: state.playbackState,
    uri: coordinator.avTransportUri,
    metadata: coordinator.avTransportUriMetadata,
    playMode: { repeat: state.playMode.repeat },
  };
  if (hasQueuePosition(coordinator.avTransportUri, state.trackNo)) {
    preset.trackNo = state.trackNo;
    preset.elapsedTime = state.elapsedTime;
  }

  return preset;
}

function zoneStep(zone: Zone): RestoreStep {
  const coordinator = zone.coordinator;
  return {
    kind: 'zone',
    room: coordinator.roomName,
    preset: {
      players: [
        { roomName: coordinator.roomName, volume: coordinator.state.volume },
        ...zone.members
          .filter((member) => member.uuid !== coordinator.uuid)
          .map((member) => ({ roomName: member.roomName, volume: member.state.volume })),
      ],
      ...transportBackup(coordinator),
    },
  };
}

function rejoinStep(player: Player, groupOf: Player[]): RestoreStep {
  return {
    kind: 'rejoin',
    room: player.roomName,
    volume: player.state.volume,
    groupOf: groupOf.map((survivor) => survivor.uuid),
  };
}

/**
 * Works out, before anything is touched, what each zone needs afterwards: zones whose
 * coordinator takes part are re-formed whole; players that leave a group they did not lead
 * rejoin it; groups that `pauseOthers` will pause are resumed; everything else is left alone.
 */
export function captureRestorePlan(system: AnnounceSystem, plan: AnnouncementPlan): RestorePlan {
  const targets = new Set(plan.preset.players.map((player) => player.roomName.toLowerCase()));
  const isTarget = (player: Player): boolean => targets.has(player.roomName.toLowerCase());
  const steps: RestoreStep[] = [];

  const zones = [...system.zones].sort((a, b) => b.members.length - a.members.length);
  for (const zone of zones) {
    const coordinator = zone.coordinator;
    const leaving = zone.members.filter(isTarget);
    const staying = zone.members.filter((member) => !isTarget(member));
    if (leaving.length === 0) {
      if (plan.preset.pauseOthers && coordinator.state.playbackState === 'PLAYING') {
        steps.push({ kind: 'resume', room: coordinator.roomName });
      }
    } else if (!isTarget(coordinator)) {
      steps.push(...leaving.map((member) => rejoinStep(member, staying)));
    } else if (leaving.length === 1 && staying.length > 0) {
      // Only the leader leaves; the rest keep playing under a new one, so it just rejoins them.
      steps.push(rejoinStep(coordinator, staying));
    } else {
      steps.push(zoneStep(zone));
    }
  }

  const last = steps.findIndex((step) => step.room === plan.coordinator.roomName);
  if (last >= 0) {
    steps.push(...steps.splice(last, 1));
  }

  return { steps };
}

export interface RestoreOptions {
  logger?: Logger | undefined;
  /** How long to wait for the topology to show the groups back in place. */
  verifyTimeoutMs: number;
}

export interface RestoreOutcome {
  restore: 'ok' | 'partial';
  warnings: string[];
}

const STEP_CONCURRENCY = 3;

function zoneContaining(zones: Zone[], uuids: string[]): Zone | undefined {
  return zones.find((zone) => zone.members.some((member) => uuids.includes(member.uuid)));
}

function findPlayer(system: AnnounceSystem, room: string): Player {
  const player = system.players.find((candidate) => candidate.roomName === room);
  if (!player) {
    throw new Error(`Player '${room}' has disappeared`);
  }

  return player;
}

async function runStep(system: AnnounceSystem, step: RestoreStep, logger: Logger): Promise<void> {
  switch (step.kind) {
    case 'zone':
      await system.applyPreset(step.preset);
      return;
    case 'rejoin': {
      const player = findPlayer(system, step.room);
      const leader = zoneContaining(system.zones, step.groupOf)?.coordinator;
      if (!leader) {
        logger.debug({ room: step.room }, 'the group it left is gone; staying standalone');
      } else if (player.coordinator.uuid !== leader.uuid) {
        await player.setAVTransport(`x-rincon:${leader.uuid}`);
      }

      await player.setVolume(step.volume);
      return;
    }
    case 'resume':
      await findPlayer(system, step.room).play();
  }
}

/** Whether the zones show the step's outcome; a rejoin whose group vanished has nothing to show. */
function stepSettled(step: RestoreStep, zones: Zone[]): boolean {
  switch (step.kind) {
    case 'zone': {
      const rooms = new Set(step.preset.players.map((player) => player.roomName));
      return zones.some(
        (zone) =>
          zone.coordinator.roomName === step.room &&
          zone.members.length === rooms.size &&
          zone.members.every((member) => rooms.has(member.roomName)),
      );
    }
    case 'rejoin': {
      const target = zoneContaining(zones, step.groupOf);
      return !target || target.members.some((member) => member.roomName === step.room);
    }
    case 'resume':
      return true;
  }
}

function describe(step: RestoreStep, verifyTimeoutMs: number): string {
  return step.kind === 'zone'
    ? `${step.room}: group not re-formed after ${verifyTimeoutMs} ms`
    : `${step.room}: still grouped elsewhere after ${verifyTimeoutMs} ms`;
}

/**
 * Puts the rooms back: every step but the coordinator's runs concurrently (they touch disjoint
 * players), the coordinator's last so nothing it commands is fighting a step still in flight.
 * Each step gets one retry; what still fails becomes a warning rather than an error, and the
 * topology is then given `verifyTimeoutMs` to show the groups back in place.
 */
export async function runRestore(
  system: AnnounceSystem,
  plan: RestorePlan,
  options: RestoreOptions,
): Promise<RestoreOutcome> {
  const logger = options.logger ?? silentLogger;
  const warnings: string[] = [];
  const attempt = async (step: RestoreStep): Promise<void> => {
    logger.debug({ step }, 'restoring');
    try {
      // Players are often still busy regrouping after an announcement; one retry after a
      // pause recovers most steps that would otherwise leave a room on the clip.
      await withTransientRetry(() => runStep(system, step, logger), {
        label: `restore ${step.kind} ${step.room}`,
        backoffMs: 1000,
        retryOn: () => true,
        logger,
      });
    } catch (error) {
      logger.warn({ err: error, step }, 'restore step failed');
      warnings.push(`${step.room}: ${step.kind} failed: ${errorMessage(error)}`);
    }
  };

  const others = plan.steps.slice(0, -1);
  const coordinator = plan.steps.at(-1);
  await mapLimit(others, STEP_CONCURRENCY, attempt);
  if (coordinator) {
    await attempt(coordinator);
  }

  const settled = await waitForTopology(
    system,
    (zones) => plan.steps.every((step) => stepSettled(step, zones)),
    { timeoutMs: options.verifyTimeoutMs },
  );
  if (settled !== 'matched') {
    for (const step of plan.steps.filter((step) => !stepSettled(step, system.zones))) {
      warnings.push(describe(step, options.verifyTimeoutMs));
    }
    logger.warn({ warnings }, 'the topology did not settle after the restore');
  }

  return { restore: warnings.length === 0 ? 'ok' : 'partial', warnings };
}
