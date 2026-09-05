/**
 * Manual smoke test for the discovery layer against the real Sonos system on the LAN:
 * discovers the players, prints the zones once the music services are known, then disposes.
 *
 *   npm run smoke:discovery
 */
import { SonosSystem } from '../src/discovery/sonos-system.ts';
import { LOG_LEVELS, createLogger } from '../src/logger.ts';

const requestedLevel = process.env.LOG_LEVEL;
const level = LOG_LEVELS.find((candidate) => candidate === requestedLevel) ?? 'info';
const logger = createLogger({ level });
const discoveryHosts = (process.env.SONOS_DISCOVERY_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0);
const system = new SonosSystem(
  { household: process.env.SONOS_HOUSEHOLD, discoveryHosts },
  { logger },
);

const timeout = setTimeout(() => {
  logger.error('no Sonos system found within 30 seconds');
  process.exitCode = 1;
  void system.dispose();
}, 30_000);

system.once('initialized', () => {
  clearTimeout(timeout);
  for (const zone of system.zones) {
    logger.info(
      {
        coordinator: zone.coordinator.roomName,
        members: zone.members.map((member) => `${member.roomName} (vol ${member.state.volume})`),
        playing: zone.coordinator.state.playbackState,
      },
      'zone',
    );
  }

  logger.info(
    {
      localEndpoint: system.localEndpoint,
      players: system.players.length,
      services: Object.keys(system.availableServices).length,
    },
    'discovery complete',
  );
  void system.dispose();
});

system.start();
