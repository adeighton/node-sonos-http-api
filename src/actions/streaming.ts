import type { Player } from '../discovery/player.ts';
import { nodeText } from '../discovery/xml.ts';
import { BadRequestError } from '../http/errors.ts';
import { DIDL_NAMESPACES } from '../music/types.ts';
import { requireValue } from './parse.ts';
import type { Action, ActionContext, ActionRegistry } from './registry.ts';

export const STREAMING_ACTIONS = ['queue', 'now', 'next'] as const;
export type StreamingAction = (typeof STREAMING_ACTIONS)[number];

function parseStreamingAction(value: string | undefined): StreamingAction {
  if (!STREAMING_ACTIONS.includes(value as StreamingAction)) {
    throw new BadRequestError(
      `Expected one of ${STREAMING_ACTIONS.join(', ')}, got '${value ?? ''}'`,
    );
  }

  return value as StreamingAction;
}

/** Queues, plays now (inserted after the current track) or plays next, the way every service action does. */
export async function queueOrPlay(
  player: Player,
  action: StreamingAction,
  uri: string,
  metadata: string,
): Promise<void> {
  const coordinator = player.coordinator;
  if (action === 'queue') {
    await coordinator.addURIToQueue(uri, metadata);
    return;
  }

  const nextTrackNo = coordinator.state.trackNo + 1;
  if (action === 'next') {
    await coordinator.addURIToQueue(uri, metadata, true, nextTrackNo);
    return;
  }

  if (!coordinator.avTransportUri.startsWith('x-rincon-queue')) {
    await coordinator.setAVTransport(`x-rincon-queue:${coordinator.uuid}#0`);
  }

  const added = await coordinator.addURIToQueue(uri, metadata, true, nextTrackNo);
  const enqueuedAt = Number.parseInt(nodeText(added.firsttracknumberenqueued) ?? '', 10);
  await coordinator.trackSeek(Number.isNaN(enqueuedAt) ? nextTrackNo : enqueuedAt);
  await coordinator.play();
}

function didl(
  id: string,
  parentId: string,
  objectClass: string,
  token: string,
  title = '',
): string {
  return `<DIDL-Lite ${DIDL_NAMESPACES}><item id="${id}" parentID="${parentId}" restricted="true"><dc:title>${title}</dc:title><upnp:class>${objectClass}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc></item></DIDL-Lite>`;
}

/** `{type}:{id}` as used by the Apple/Amazon/Napster actions. */
function parseTypedId<T extends string>(
  value: string | undefined,
  types: readonly T[],
): { type: T; id: string } {
  const [type, ...rest] = requireValue(value, 'item').split(':');
  const id = rest.join(':');
  if (!types.includes(type as T) || id === '') {
    throw new BadRequestError(`Expected {${types.join('|')}}:{id}, got '${value ?? ''}'`);
  }

  return { type: type as T, id };
}

// --- Spotify -----------------------------------------------------------------------------------

export function spotifyUriAndMetadata(spotifyUri: string, sid: number, serviceType: number) {
  const encoded = encodeURIComponent(spotifyUri);
  const uri = spotifyUri.startsWith('spotify:track:')
    ? `x-sonos-spotify:${encoded}?sid=${sid}&flags=32&sn=1`
    : `x-rincon-cpcontainer:0006206c${encoded}`;
  const metadata = `<DIDL-Lite ${DIDL_NAMESPACES}><item id="00030020${encoded}" restricted="true"><upnp:class>object.item.audioItem.musicTrack</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${serviceType}_X_#Svc${serviceType}-0-Token</desc></item></DIDL-Lite>`;
  return { uri, metadata };
}

const spotify: Action = async ({ player, system }, values) => {
  const action = parseStreamingAction(values[0]);
  const spotifyUri = requireValue(values[1], 'spotify uri');
  if (!spotifyUri.startsWith('spotify:')) {
    throw new BadRequestError(`Expected a spotify:… uri, got '${spotifyUri}'`);
  }

  const { uri, metadata } = spotifyUriAndMetadata(
    spotifyUri,
    system.getServiceId('Spotify'),
    system.getServiceType('Spotify'),
  );
  await queueOrPlay(player, action, uri, metadata);
};

// --- Apple Music ---------------------------------------------------------------------------------

const APPLE_TYPES = ['song', 'album', 'playlist'] as const;
const APPLE = {
  song: {
    uri: (id: string) => `x-sonos-http:${id}.mp4?sid=204&flags=8224&sn=4`,
    prefix: '00032020',
    parent: '0004206calbum%3a',
    objectClass: 'object.item.audioItem.musicTrack',
  },
  album: {
    uri: (id: string) => `x-rincon-cpcontainer:0004206c${id}`,
    prefix: '0004206c',
    parent: '00020000album%3a',
    objectClass: 'object.item.audioItem.musicAlbum',
  },
  playlist: {
    uri: (id: string) => `x-rincon-cpcontainer:1006206c${id}`,
    prefix: '1006206c',
    parent: '1006206cplaylist%3a',
    objectClass: 'object.container.playlistContainer.#PlaylistView',
  },
} as const;

const appleMusic: Action = async ({ player }, values) => {
  const action = parseStreamingAction(values[0]);
  const { type, id } = parseTypedId(values[1], APPLE_TYPES);
  const spec = APPLE[type];
  const encodedTypedId = encodeURIComponent(`${type}:${id}`);
  await queueOrPlay(
    player,
    action,
    spec.uri(encodedTypedId),
    didl(
      `${spec.prefix}${encodedTypedId}`,
      spec.parent,
      spec.objectClass,
      'SA_RINCON52231_X_#Svc52231-0-Token',
    ),
  );
};

// --- Amazon Music --------------------------------------------------------------------------------

const AMAZON_TYPES = ['song', 'album'] as const;
const AMAZON = {
  song: {
    uri: (id: string) =>
      `x-sonosapi-hls-static:catalog%2ftracks%2f${id}%2f%3falbumAsin%3dB01JDKZWK0?sid=201&flags=0&sn=4`,
    prefix: '10030000catalog%2ftracks%2f',
    suffix: '%2f%3falbumAsin%3d',
    parent: '1004206ccatalog%2falbums%2f',
    objectClass: 'object.container.album.musicAlbum.#AlbumView',
  },
  album: {
    uri: (id: string) =>
      `x-rincon-cpcontainer:1004206ccatalog%2falbums%2f${id}%2f%23album_desc?sid=201&flags=8300&sn=4`,
    prefix: '1004206ccatalog',
    suffix: '%2f%23album_desc',
    parent: '10052064catalog%2fartists%2f',
    objectClass: 'object.container.album.musicAlbum',
  },
} as const;

const amazonMusic: Action = async ({ player }, values) => {
  const action = parseStreamingAction(values[0]);
  const { type, id } = parseTypedId(values[1], AMAZON_TYPES);
  const spec = AMAZON[type];
  const encodedId = encodeURIComponent(id);
  await queueOrPlay(
    player,
    action,
    spec.uri(encodedId),
    didl(
      `${spec.prefix}${encodedId}${spec.suffix}`,
      spec.parent,
      spec.objectClass,
      'SA_RINCON51463_X_#Svc51463-0-Token',
    ),
  );
};

// --- Napster / Aldi life Music (same catalog, different service ids) ------------------------------

const NAPSTER_TYPES = ['song', 'album'] as const;

function napsterLike(name: string, serviceType: number, sid: number): Action {
  const token = `SA_RINCON${serviceType}_X_#Svc${serviceType}-0-Token`;
  return async ({ player }: ActionContext, values: string[]) => {
    const action = parseStreamingAction(values[0]);
    const { type, id } = parseTypedId(values[1], NAPSTER_TYPES);
    const encodedId = encodeURIComponent(id);
    const uri =
      type === 'song'
        ? `x-sonos-http:ondemand_track%3a%3atra.${encodedId}%7cv1%7cALBUM%7calb.mp4?sid=${sid}&flags=8224&sn=13`
        : `x-rincon-cpcontainer:100420ecexplore%3aalbum%3a%3aAlb.${encodedId}`;
    const metadata =
      type === 'song'
        ? didl(
            `10032020ondemand_track%3a%3atra.${encodedId}`,
            '100420ecexplore%3a',
            'object.item.audioItem.musicTrack',
            token,
          )
        : didl(
            `100420ec${encodedId}`,
            '100420ecexplore%3aalbum%3a',
            'object.container.album.musicAlbum',
            token,
          );
    await queueOrPlay(player, action, uri, metadata);
  };
}

export function registerStreamingActions(registry: ActionRegistry): void {
  registry.register('spotify', spotify, {
    usage: '/{room}/spotify/{queue|now|next}/{spotify:track:…|spotify:album:…}',
    description: 'Queue or play a Spotify track, album or playlist by its Spotify uri.',
  });
  registry.register('applemusic', appleMusic, {
    usage: '/{room}/applemusic/{queue|now|next}/{song|album|playlist}:{id}',
    description: 'Queue or play an Apple Music item by id.',
  });
  registry.register('amazonmusic', amazonMusic, {
    usage: '/{room}/amazonmusic/{queue|now|next}/{song|album}:{id}',
    description: 'Queue or play an Amazon Music item by id.',
  });
  registry.register('napster', napsterLike('napster', 51975, 203), {
    usage: '/{room}/napster/{queue|now|next}/{song|album}:{id}',
    description: 'Queue or play a Napster item by id.',
  });
  registry.register('aldilifemusic', napsterLike('aldilifemusic', 55303, 216), {
    usage: '/{room}/aldilifemusic/{queue|now|next}/{song|album}:{id}',
    description: 'Queue or play an Aldi life Music item by id.',
  });
}
