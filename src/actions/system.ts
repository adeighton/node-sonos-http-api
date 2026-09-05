import type { Action, ActionRegistry } from './registry.ts';

const reindex: Action = async ({ system }) => {
  await system.refreshShareIndex();
};

/** `/services` lists the music service names known to the system; `/services/all` the details. */
const services: Action = ({ system }, values) =>
  Promise.resolve(
    values[0] === 'all' ? system.availableServices : Object.keys(system.availableServices).sort(),
  );

const debug: Action = ({ system, version }) =>
  Promise.resolve({
    version,
    system: {
      localEndpoint: system.localEndpoint,
      availableServices: system.availableServices,
    },
    players: system.players.map((player) => ({
      roomName: player.roomName,
      uuid: player.uuid,
      coordinator: player.coordinator.uuid,
      avTransportUri: player.avTransportUri,
      avTransportUriMetadata: player.avTransportUriMetadata,
      baseUrl: player.baseUrl,
      hasSub: player.hasSub,
      outputFixed: player.outputFixed,
      state: player.debugSnapshot(),
    })),
  });

export function registerSystemActions(registry: ActionRegistry): void {
  registry.register('reindex', reindex, {
    usage: '/reindex',
    description: 'Ask the system to re-index the music library.',
  });
  registry.register('services', services, {
    usage: '/services[/all]',
    description: 'The music services known to the Sonos system.',
  });
  registry.register('debug', debug, {
    usage: '/debug',
    description: 'Internal state of every player, for troubleshooting.',
  });
}
