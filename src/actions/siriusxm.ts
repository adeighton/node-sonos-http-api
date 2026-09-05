import Fuse from 'fuse.js';

import channels from '../data/sirius-channels.json' with { type: 'json' };
import { NotFoundError } from '../http/errors.ts';
import { DIDL_NAMESPACES } from '../music/types.ts';
import { requireValue } from './parse.ts';
import type { Action, ActionRegistry } from './registry.ts';

export interface SiriusChannel {
  fullTitle: string;
  channelNum: string;
  title: string;
  id: string;
  parentID: string;
}

const CHANNELS: SiriusChannel[] = channels;

export function siriusXmMetadata(channel: SiriusChannel): string {
  return `<DIDL-Lite ${DIDL_NAMESPACES}><item id="00092120r%3a${channel.id}" parentID="${channel.parentID}" restricted="true"><dc:title>${channel.fullTitle}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">_</desc></item></DIDL-Lite>`;
}

export function siriusXmUri(channel: SiriusChannel): string {
  return `x-sonosapi-hls:r%3a${channel.id}?sid=37&flags=8480&sn=11`;
}

const index = new Fuse(CHANNELS, { keys: ['channelNum', 'title'] });

/** The best matching channel for a number or (part of) a name. */
export function findSiriusChannel(query: string): SiriusChannel | undefined {
  return index.search(query)[0]?.item;
}

/** `/siriusxm/{channel number or name}`; `/siriusxm/channels` and `/siriusxm/stations` list them. */
const siriusXm: Action = async ({ player }, values) => {
  const query = requireValue(values[0], 'channel number or station name');
  if (query === 'channels') {
    return CHANNELS.map((channel) => channel.channelNum).sort((a, b) => Number(a) - Number(b));
  }

  if (query === 'stations') {
    return CHANNELS.map((channel) => channel.title).sort((a, b) => a.localeCompare(b));
  }

  const channel = findSiriusChannel(query);
  if (!channel) {
    throw new NotFoundError(`No SiriusXM channel matches '${query}'`);
  }

  await player.coordinator.setAVTransport(siriusXmUri(channel), siriusXmMetadata(channel));
  await player.coordinator.play();
  return { status: 'success', channel: channel.fullTitle };
};

export function registerSiriusXmActions(registry: ActionRegistry): void {
  registry.register('siriusxm', siriusXm, {
    usage: '/{room}/siriusxm/{channel number|station name|channels|stations}',
    description: 'Play a SiriusXM channel by number or name (fuzzy), or list the known channels.',
  });
}
