import { playWhenReady } from '../discovery/retry.ts';
import { BadRequestError } from '../http/errors.ts';
import { requireValue } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

export function bbcSoundsMetadata(station: string): string {
  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="83207${station}" parentID="L" restricted="true"><dc:title>BBC Sounds</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON83207_</desc></item></DIDL-Lite>`;
}

export function bbcSoundsUri(station: string): string {
  return `x-sonosapi-hls:stations%7eplayable%7e%7e${station}%7e%7eurn%3abbc%3aradio%3anetwork%3a${station}?sid=325&flags=288&sn=10`;
}

/** `/{room}/bbcsounds/{play|set}/{station}` (station names: bbc_radio_one, bbc_6music, ...). */
const bbcSounds: Action = async ({ player, logger }, values) => {
  const action = values[0];
  const station = encodeURIComponent(requireValue(values[1], 'BBC Sounds station name'));
  if (action !== 'play' && action !== 'set') {
    throw new BadRequestError("bbcsounds expects 'play' or 'set' followed by a station name");
  }

  await player.coordinator.setAVTransport(bbcSoundsUri(station), bbcSoundsMetadata(station));
  if (action === 'play') {
    await playWhenReady(player.coordinator, logger);
  }
};

export function registerBbcSoundsActions(registry: ActionRegistry): void {
  registry.register('bbcsounds', bbcSounds, {
    usage: '/{room}/bbcsounds/{play|set}/{station}',
    description: 'Play (or just select) a BBC Sounds station, e.g. bbc_radio_two.',
  });
}
