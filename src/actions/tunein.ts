import { playWhenReady } from '../discovery/retry.ts';
import { BadRequestError } from '../http/errors.ts';
import { requireValue } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

export function tuneInMetadata(encodedStationId: string, serviceType: number): string {
  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="F00092020s${encodedStationId}" parentID="L" restricted="true"><dc:title>tunein</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${serviceType}_</desc></item></DIDL-Lite>`;
}

export function tuneInUri(encodedStationId: string, serviceId: number): string {
  return `x-sonosapi-stream:s${encodedStationId}?sid=${serviceId}&flags=8224&sn=0`;
}

/** `/{room}/tunein/{play|set}/{station id}` */
const tuneIn: Action = async ({ player, system, logger }, values) => {
  const action = values[0];
  const stationId = encodeURIComponent(requireValue(values[1], 'TuneIn station id'));
  if (action !== 'play' && action !== 'set') {
    throw new BadRequestError("tunein expects 'play' or 'set' followed by a station id");
  }

  const uri = tuneInUri(stationId, system.getServiceId('TuneIn'));
  const metadata = tuneInMetadata(stationId, system.getServiceType('TuneIn'));
  await player.coordinator.setAVTransport(uri, metadata);
  if (action === 'play') {
    await playWhenReady(player.coordinator, logger);
  }
};

export function registerTuneInActions(registry: ActionRegistry): void {
  registry.register('tunein', tuneIn, {
    usage: '/{room}/tunein/{play|set}/{station id}',
    description: 'Play (or just select) a TuneIn station by its id.',
  });
}
