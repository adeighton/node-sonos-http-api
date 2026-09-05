import type { NextTrack, Track } from './player-state.ts';
import { createEmptyNextTrack, createEmptyTrack, parseTime } from './player-state.ts';
import type { BrowseItem } from './types.ts';
import { XML_ARRAYS, nodeAttrs, nodeText, parseXmlEvents } from './xml.ts';
import type { XmlNode } from './xml.ts';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstIfArray(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return stringOrUndefined(value[0]);
  }

  return stringOrUndefined(value);
}

function applyItemToTrack(target: Track | NextTrack, item: XmlNode): void {
  const res = item.res;
  const uri = nodeText(res);
  target.uri = uri ?? '';
  if ('trackUri' in target) {
    target.trackUri = uri;
  }

  target.duration = res === undefined ? 0 : parseTime(nodeAttrs(res).duration);
  target.artist = stringOrUndefined(item['dc:creator']);
  target.album = stringOrUndefined(item['upnp:album']);
  // Radio stations carry the current song in r:streamContent instead of dc:title.
  target.title = stringOrUndefined(item['r:streamcontent']) || stringOrUndefined(item['dc:title']);
  target.albumArtUri = firstIfArray(item['upnp:albumarturi']);
}

/** Parses the DIDL-Lite of the current track from an AVTransport LastChange event. */
export async function parseCurrentTrackMetadata(xml: string | undefined): Promise<Track> {
  const track = createEmptyTrack();
  if (!xml) {
    return track;
  }

  await parseXmlEvents(xml, { item: (item) => applyItemToTrack(track, item) });
  return track;
}

/** Parses the DIDL-Lite of the next track from an AVTransport LastChange event. */
export async function parseNextTrackMetadata(xml: string | undefined): Promise<NextTrack> {
  const track = createEmptyNextTrack();
  if (!xml) {
    return track;
  }

  await parseXmlEvents(xml, { item: (item) => applyItemToTrack(track, item) });
  return track;
}

export interface EnqueuedMetadata {
  title?: string;
  albumArtURI?: string;
}

/** Parses the DIDL-Lite describing what was enqueued (playlist, station or album). */
export async function parseEnqueuedMetadata(xml: string | undefined): Promise<EnqueuedMetadata> {
  const enqueued: EnqueuedMetadata = {};
  if (!xml) {
    return enqueued;
  }

  await parseXmlEvents(xml, {
    item: (item) => {
      enqueued.title = stringOrUndefined(item['dc:title']);
      enqueued.albumArtURI = firstIfArray(item['upnp:albumarturi']);
    },
  });

  return enqueued;
}

/** Parses the DIDL-Lite `Result` of a ContentDirectory Browse into queue/list items. */
export async function parseBrowseItems(didl: string | undefined): Promise<BrowseItem[]> {
  const items: BrowseItem[] = [];
  if (!didl) {
    return items;
  }

  await parseXmlEvents(
    didl,
    {
      item: (item) => {
        items.push({
          uri: nodeText(item.res) ?? '',
          title: stringOrUndefined(item['dc:title']),
          artist: stringOrUndefined(item['dc:creator']),
          album: stringOrUndefined(item['upnp:album']),
          albumTrackNumber: stringOrUndefined(item['upnp:originaltracknumber']),
          albumArtUri: firstIfArray(item['upnp:albumarturi']),
          metadata: stringOrUndefined(item['r:resmd']),
        });
      },
      container: (container) => {
        const art = container['upnp:albumarturi'];
        items.push({
          uri: nodeText(container.res) ?? '',
          title: stringOrUndefined(container['dc:title']),
          artist: stringOrUndefined(container['dc:creator']),
          albumArtUri: Array.isArray(art) ? (art as string[]) : stringOrUndefined(art),
        });
      },
    },
    { preserveMarkup: XML_ARRAYS.NEVER },
  );

  return items;
}
