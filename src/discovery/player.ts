import { EventEmitter } from 'node:events';

import { decode, encode } from 'html-entities';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import {
  parseBrowseItems,
  parseCurrentTrackMetadata,
  parseEnqueuedMetadata,
  parseNextTrackMetadata,
} from './metadata.ts';
import {
  PLAY_MODE,
  REPEAT_MODE,
  SUB_POLARITY,
  URI_TYPE,
  buildSnapshot,
  createEmptyState,
  formatTime,
  getPlayMode,
  getUriType,
  parseTime,
} from './player-state.ts';
import type {
  InternalState,
  ListType,
  NextTrack,
  PlayMode,
  PlayModeName,
  PlayerSnapshot,
  RepeatMode,
  SubState,
  Track,
  UriType,
} from './player-state.ts';
import { SOAP_ACTIONS } from './soap.ts';
import type { SoapAction, SoapClient, SoapValues } from './soap.ts';
import type { BrowseItem, BrowseResult, LastChangeData, ZoneMemberData } from './types.ts';
import { asArray, nodeValue } from './xml.ts';
import type { XmlNode } from './xml.ts';

/** A Sonos group: one coordinator plus its (visible) members, as reported by ZoneGroupTopology. */
export interface Zone {
  coordinator: Player;
  members: Player[];
  uuid: string;
  id: string;
}

export interface VolumeChangeEvent {
  uuid: string;
  previousVolume: number;
  newVolume: number;
  roomName: string;
}

export interface MuteChangeEvent {
  uuid: string;
  previousMute: boolean;
  newMute: boolean;
  roomName: string;
}

export interface GroupVolumeEvent {
  uuid: string;
  oldVolume: number;
  newVolume: number;
  roomName: string;
}

export interface PlayerEvents {
  'transport-state': [Readonly<PlayerSnapshot>];
  'volume-change': [VolumeChangeEvent];
  'mute-change': [MuteChangeEvent];
  'group-mute': [MuteChangeEvent];
  'group-volume': [GroupVolumeEvent];
}

/** Events emitted by the SonosSystem; players re-emit their own events here with their uuid. */
export interface SonosSystemEvents {
  'topology-change': [Zone[]];
  'transport-state': [Player];
  'volume-change': [VolumeChangeEvent];
  'mute-change': [MuteChangeEvent];
  'group-mute': [MuteChangeEvent];
  'group-volume': [GroupVolumeEvent];
  'queue-change': [Player];
  'list-change': [ListType];
  initialized: [];
}

/** The subset of SonosSystem a Player needs (kept small so tests can use fakes). */
export interface PlayerSystem extends Pick<EventEmitter<SonosSystemEvents>, 'emit'> {
  zones: Zone[];
  getFavorites(): Promise<BrowseItem[]>;
  getPlaylists(): Promise<BrowseItem[]>;
}

export interface SubscriberLike {
  dispose(): Promise<void> | void;
}

export interface PlayerDeps {
  soap: SoapClient;
  createSubscriber: (subscribeUrl: string, notificationUrl: string) => SubscriberLike;
  /** Resolves a high-resolution album art url for a track uri; rejects when no service knows it. */
  artLookup: (uri: string) => Promise<string | undefined>;
  logger?: Logger;
}

export interface GroupState {
  volume: number;
  mute: boolean;
}

const SUBSCRIBE_ENDPOINTS = [
  '/MediaRenderer/AVTransport/Event',
  '/MediaRenderer/RenderingControl/Event',
  '/MediaRenderer/GroupRenderingControl/Event',
  '/MediaServer/ContentDirectory/Event',
];

const AV_TRANSPORT = '/MediaRenderer/AVTransport/Control';
const RENDERING_CONTROL = '/MediaRenderer/RenderingControl/Control';
const GROUP_RENDERING_CONTROL = '/MediaRenderer/GroupRenderingControl/Control';
const CONTENT_DIRECTORY = '/MediaServer/ContentDirectory/Control';

const QUEUE_OBJECT_ID = 'Q:0';
const MAX_VOLUME = 100;

function xmlEncode(text: string): string {
  return encode(text, { level: 'xml' });
}

function toInt(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function hasSubwoofer(data: ZoneMemberData): boolean {
  const channelMap = data.channelmapset ?? data.htsatchanmapset ?? '';
  return /:SW/.test(channelMap);
}

/**
 * One Sonos player (zone). Holds the mutable state fed by UPnP notifications and exposes the
 * SOAP commands. The `state` getter merges this player's own volume/mute/equalizer with the
 * transport state of its group coordinator, exactly as the Sonos apps present it.
 */
export class Player extends EventEmitter<PlayerEvents> {
  readonly uuid: string;
  readonly roomName: string;
  readonly baseUrl: string;
  readonly system: PlayerSystem;
  /** The group coordinator; SonosSystem keeps this current, and it defaults to the player itself. */
  coordinator: Player;
  avTransportUri = '';
  avTransportUriMetadata = '';
  outputFixed = false;
  readonly hasSub: boolean;
  sub: SubState = {};
  groupState: GroupState = { volume: 0, mute: false };

  readonly #state: InternalState = createEmptyState();
  readonly #soap: SoapClient;
  readonly #artLookup: PlayerDeps['artLookup'];
  readonly #logger: Logger;
  readonly #subscriptions: SubscriberLike[];
  #previousGroupVolume: number | undefined;
  #groupVolumeTimer: NodeJS.Timeout | undefined;

  constructor(
    data: ZoneMemberData,
    notificationEndpoint: string,
    system: PlayerSystem,
    deps: PlayerDeps,
  ) {
    super();
    this.system = system;
    this.roomName = data.zonename;
    this.uuid = data.uuid;
    this.coordinator = this;
    this.hasSub = hasSubwoofer(data);
    this.#soap = deps.soap;
    this.#artLookup = deps.artLookup;
    this.#logger = deps.logger ?? silentLogger;

    const location = new URL(data.location);
    this.baseUrl = `${location.protocol}//${location.host}`;

    this.#subscriptions = SUBSCRIBE_ENDPOINTS.map((path) =>
      deps.createSubscriber(`${this.baseUrl}${path}`, notificationEndpoint),
    );
  }

  /** A frozen snapshot of what this player is doing right now. */
  get state(): Readonly<PlayerSnapshot> {
    return buildSnapshot(this.#state, this.coordinator.#state, this.hasSub ? this.sub : null);
  }

  /** A deep copy of the raw internal state, for the debug endpoint. */
  debugSnapshot(): InternalState {
    return structuredClone(this.#state);
  }

  /** Cancels the UPnP subscriptions and any pending timers. */
  async dispose(): Promise<void> {
    clearTimeout(this.#groupVolumeTimer);
    this.#groupVolumeTimer = undefined;
    await Promise.all(
      this.#subscriptions.map(async (subscription) => {
        await subscription.dispose();
      }),
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      uuid: this.uuid,
      coordinator: this.coordinator.uuid,
      roomName: this.roomName,
      state: this.state,
      groupState: this.coordinator.groupState,
      avTransportUri: this.avTransportUri,
      avTransportUriMetadata: this.avTransportUriMetadata,
    };
  }

  getUriType(uri: string): UriType {
    return getUriType(uri);
  }

  // --- notification handling ---------------------------------------------------------------

  /**
   * Applies an AVTransport or RenderingControl LastChange event. Resolves once every derived
   * update (metadata parsing, position info, events) has been processed; failures are logged.
   */
  async handleLastChange(data: LastChangeData): Promise<void> {
    const state = this.#state;

    if (data.avtransporturi) {
      this.avTransportUri = decode(nodeValue(data.avtransporturi) ?? '', { level: 'xml' });
    }

    if (data.avtransporturimetadata) {
      this.avTransportUriMetadata = nodeValue(data.avtransporturimetadata) ?? '';
    }

    if (data.transportstate) {
      try {
        await this.#handleTransportChange(data);
      } catch (error) {
        this.#logger.error(
          { err: error, room: this.roomName },
          'failed to process transport state',
        );
      }
    }

    const mute = asArray(data.mute).find((channel) => channel.channel === 'Master');
    if (mute) {
      const previousMute = state.mute;
      state.mute = mute.val === '1';
      const event: MuteChangeEvent = {
        uuid: this.uuid,
        previousMute,
        newMute: state.mute,
        roomName: this.roomName,
      };
      this.emit('mute-change', event);
      this.system.emit('mute-change', event);
    }

    const volume = asArray(data.volume).find((channel) => channel.channel === 'Master');
    if (volume) {
      const previousVolume = state.volume;
      state.volume = toInt(volume.val);
      const event: VolumeChangeEvent = {
        uuid: this.uuid,
        previousVolume,
        newVolume: state.volume,
        roomName: this.roomName,
      };
      this.emit('volume-change', event);
      this.system.emit('volume-change', event);
      this.coordinator.recalculateGroupVolume();
    }

    if (data.outputfixed) {
      this.outputFixed = nodeValue(data.outputfixed) === '1';
    }

    if (data.subgain) {
      this.sub.gain = toInt(nodeValue(data.subgain));
    }

    if (data.subcrossover) {
      this.sub.crossover = toInt(nodeValue(data.subcrossover));
    }

    if (data.subpolarity) {
      this.sub.polarity = toInt(nodeValue(data.subpolarity));
    }

    if (data.subenabled) {
      this.sub.enabled = nodeValue(data.subenabled) === '1';
    }

    if (data.bass) {
      state.equalizer.bass = toInt(nodeValue(data.bass));
    }

    if (data.treble) {
      state.equalizer.treble = toInt(nodeValue(data.treble));
    }

    if (data.dialoglevel) {
      state.equalizer.speechEnhancement = nodeValue(data.dialoglevel) === '1';
    }

    if (data.nightmode) {
      state.equalizer.nightMode = nodeValue(data.nightmode) === '1';
    }

    if (data.loudness) {
      state.equalizer.loudness = nodeValue(data.loudness) === '1';
    }
  }

  /** Applies a GroupRenderingControl GroupMute notification. */
  handleGroupMute(mute: string): void {
    const previousMute = this.groupState.mute;
    this.groupState.mute = mute === '1';
    const event: MuteChangeEvent = {
      uuid: this.uuid,
      previousMute,
      newMute: this.groupState.mute,
      roomName: this.roomName,
    };
    this.emit('group-mute', event);
    this.system.emit('group-mute', event);
  }

  async #handleTransportChange(data: LastChangeData): Promise<void> {
    const state = this.#state;
    state.playbackState = nodeValue(data.transportstate) ?? state.playbackState;
    state.trackNo = toInt(nodeValue(data.currenttrack));
    state.playMode.crossfade = nodeValue(data.currentcrossfademode) === '1';

    const playModeName = nodeValue(data.currentplaymode) as PlayModeName | undefined;
    const flags = playModeName === undefined ? 0 : (PLAY_MODE[playModeName] ?? 0);
    state.playMode.repeat =
      flags & PLAY_MODE.REPEAT_ALL
        ? REPEAT_MODE.ALL
        : flags & PLAY_MODE.REPEAT_ONE
          ? REPEAT_MODE.ONE
          : REPEAT_MODE.NONE;
    state.playMode.shuffle = Boolean(flags & PLAY_MODE.SHUFFLE_NOREPEAT);

    const inputType = getUriType(this.avTransportUri);

    const track = await parseCurrentTrackMetadata(nodeValue(data.currenttrackmetadata));
    if (!track.uri) {
      track.uri = this.avTransportUri;
    }

    track.type = inputType;
    state.currentTrack = track;
    await this.#tryReplaceWithHighResAlbumArt(track);

    const nextTrack = await parseNextTrackMetadata(nodeValue(data['r:nexttrackmetadata']));
    state.nextTrack = nextTrack;
    await this.#tryReplaceWithHighResAlbumArt(nextTrack);

    const enqueued = await parseEnqueuedMetadata(nodeValue(data['r:enqueuedtransporturimetadata']));
    if (inputType === URI_TYPE.RADIO) {
      if (state.currentTrack.artist === undefined) {
        state.currentTrack.artist = enqueued.title;
      }

      state.currentTrack.stationName = enqueued.title;
      state.currentTrack.uri = this.avTransportUri;
    } else if (inputType === URI_TYPE.TRACK) {
      state.playlistName = enqueued.title ?? '';
      state.currentTrack.absoluteAlbumArtUri =
        enqueued.albumArtURI || state.currentTrack.absoluteAlbumArtUri;
    }

    // Group members (x-rincon:) mirror their coordinator; only the coordinator reports position.
    if (
      !this.avTransportUri.startsWith('x-rincon:') &&
      this.state.playbackState !== 'TRANSITIONING'
    ) {
      await this.#getPositionInfo();
      this.emit('transport-state', this.state);
      this.system.emit('transport-state', this);
    }
  }

  async #tryReplaceWithHighResAlbumArt(track: Track | NextTrack): Promise<void> {
    if (!track.uri) {
      return;
    }

    try {
      track.absoluteAlbumArtUri = await this.#artLookup(track.uri);
    } catch {
      if (track.albumArtUri?.startsWith('http')) {
        track.absoluteAlbumArtUri = track.albumArtUri;
      } else if (track.albumArtUri) {
        track.absoluteAlbumArtUri = `${this.baseUrl}${track.albumArtUri}`;
      }
    }
  }

  async #getPositionInfo(): Promise<void> {
    try {
      const response = await this.#soap.invoke(
        `${this.baseUrl}${AV_TRANSPORT}`,
        SOAP_ACTIONS.GetPositionInfo,
      );
      const info = await this.#soap.parse(response);
      const relTime = info.reltime;
      if (typeof relTime === 'string') {
        this.#state.relTime = parseTime(relTime);
      }

      this.#state.stateTime = Date.now();
    } catch (error) {
      this.#logger.error({ err: error, room: this.roomName }, 'GetPositionInfo failed');
    }
  }

  // --- commands ------------------------------------------------------------------------------

  async #invoke(path: string, action: SoapAction, values?: SoapValues): Promise<void> {
    const response = await this.#soap.invoke(`${this.baseUrl}${path}`, action, values);
    response.stream.resume();
  }

  async #invokeAndParse(path: string, action: SoapAction, values?: SoapValues): Promise<XmlNode> {
    const response = await this.#soap.invoke(`${this.baseUrl}${path}`, action, values);
    return this.#soap.parse(response);
  }

  play(): Promise<void> {
    this.#logger.debug({ room: this.roomName }, 'play');
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Play);
  }

  pause(): Promise<void> {
    this.#logger.debug({ room: this.roomName }, 'pause');
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Pause);
  }

  stop(): Promise<void> {
    this.#logger.debug({ room: this.roomName }, 'stop');
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Stop);
  }

  nextTrack(): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Next);
  }

  previousTrack(): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Previous);
  }

  mute(): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.Mute, { mute: 1 });
  }

  unMute(): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.Mute, { mute: 0 });
  }

  muteGroup(): Promise<void> {
    return this.#invoke(GROUP_RENDERING_CONTROL, SOAP_ACTIONS.GroupMute, { mute: 1 });
  }

  unMuteGroup(): Promise<void> {
    return this.#invoke(GROUP_RENDERING_CONTROL, SOAP_ACTIONS.GroupMute, { mute: 0 });
  }

  /** Absolute (`12`) or relative (`+5`, `-5`) volume; clamped to 0..100; no-op when output is fixed. */
  setVolume(level: number | string): Promise<void> {
    if (this.outputFixed) {
      return Promise.resolve();
    }

    const text = String(level);
    let target = /^[+-]/.test(text) ? this.state.volume + toInt(text) : toInt(text);
    target = Math.min(MAX_VOLUME, Math.max(0, target));
    this.#state.volume = target;

    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.Volume, { volume: target });
  }

  setBass(level: number): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetBass, { level });
  }

  setTreble(level: number): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetTreble, { level });
  }

  timeSeek(seconds: number): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Seek, {
      unit: 'REL_TIME',
      value: formatTime(seconds),
    });
  }

  trackSeek(trackNo: number): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.Seek, { unit: 'TRACK_NR', value: trackNo });
  }

  clearQueue(): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.RemoveAllTracksFromQueue);
  }

  removeTrackFromQueue(index: number): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.RemoveTrackFromQueue, { track: index || 0 });
  }

  removeTrackRangeFromQueue(startIndex: number, numberOfTracks: number): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.RemoveTrackRangeFromQueue, {
      startIndex: toInt(String(startIndex)),
      numberOfTracks: toInt(String(numberOfTracks)),
    });
  }

  reorderTracksInQueue(
    startIndex: number,
    numberOfTracks: number,
    insertBefore: number,
  ): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.ReorderTracksInQueue, {
      startIndex: toInt(String(startIndex)),
      numberOfTracks: toInt(String(numberOfTracks)),
      insertBefore: toInt(String(insertBefore)),
    });
  }

  saveQueue(title: string): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.SaveQueue, { title: xmlEncode(title) });
  }

  addURIToQueue(
    uri: string,
    metadata = '',
    enqueueAsNext = false,
    desiredFirstTrackNumberEnqueued = 0,
  ): Promise<XmlNode> {
    return this.#invokeAndParse(AV_TRANSPORT, SOAP_ACTIONS.AddURIToQueue, {
      uri: xmlEncode(uri),
      metadata: xmlEncode(metadata),
      desiredFirstTrackNumberEnqueued,
      enqueueAsNext: enqueueAsNext ? 1 : 0,
    });
  }

  addMultipleURIsToQueue(
    elements: Array<[uri: string, metadata?: string]>,
    containerURI: string,
    containerMetadata = '',
    enqueueAsNext = false,
    desiredFirstTrackNumberEnqueued = 0,
  ): Promise<XmlNode> {
    return this.#invokeAndParse(AV_TRANSPORT, SOAP_ACTIONS.AddMultipleURIsToQueue, {
      amount: elements.length,
      uris: elements.map(([uri]) => xmlEncode(uri)).join(' '),
      metadatas: elements.map(([, metadata]) => xmlEncode(metadata ?? '')).join(' '),
      containerURI: xmlEncode(containerURI),
      containerMetadata: xmlEncode(containerMetadata),
      desiredFirstTrackNumberEnqueued,
      enqueueAsNext: enqueueAsNext ? 1 : 0,
    });
  }

  /** Sets repeat/shuffle (one SetPlayMode call) and/or crossfade; a failing play mode is only logged. */
  async setPlayMode(newPlayMode: Partial<PlayMode>): Promise<void> {
    if (newPlayMode.repeat !== undefined || newPlayMode.shuffle !== undefined) {
      const desired = { ...this.state.playMode, ...newPlayMode };
      const playMode = getPlayMode(desired);
      this.#logger.debug({ room: this.roomName, playMode }, 'setting play mode');
      try {
        await this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.SetPlayMode, { playMode });
      } catch (error) {
        this.#logger.warn(
          { err: error, room: this.roomName, playMode },
          'failed to set play mode, could be playing a radio station or line-in',
        );
      }
    }

    if (newPlayMode.crossfade !== undefined) {
      await this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.SetCrossfadeMode, {
        crossfadeMode: newPlayMode.crossfade ? 1 : 0,
      });
    }
  }

  repeat(mode: boolean | RepeatMode): Promise<void> {
    const repeat = typeof mode === 'boolean' ? (mode ? REPEAT_MODE.ALL : REPEAT_MODE.NONE) : mode;
    return this.setPlayMode({ repeat });
  }

  shuffle(enabled: boolean): Promise<void> {
    return this.setPlayMode({ shuffle: Boolean(enabled) });
  }

  crossfade(enabled: boolean): Promise<void> {
    return this.setPlayMode({ crossfade: Boolean(enabled) });
  }

  /** Sleep timer in seconds; 0 clears it. */
  sleep(seconds: number): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.ConfigureSleepTimer, {
      time: seconds === 0 ? '' : formatTime(seconds),
    });
  }

  async setAVTransport(uri: string, metadata = ''): Promise<void> {
    await this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.SetAVTransportURI, {
      uri: xmlEncode(uri),
      metadata: xmlEncode(metadata),
    });
    this.avTransportUri = uri;
    this.avTransportUriMetadata = metadata;
  }

  becomeCoordinatorOfStandaloneGroup(): Promise<void> {
    return this.#invoke(AV_TRANSPORT, SOAP_ACTIONS.BecomeCoordinatorOfStandaloneGroup);
  }

  refreshShareIndex(): Promise<void> {
    return this.#invoke(CONTENT_DIRECTORY, SOAP_ACTIONS.RefreshShareIndex);
  }

  async browse(objectId: string, startIndex = 0, limit = 0): Promise<BrowseResult> {
    const response = await this.#invokeAndParse(CONTENT_DIRECTORY, SOAP_ACTIONS.Browse, {
      objectId,
      startIndex,
      limit,
    });

    const result = response.result;
    return {
      startIndex,
      numberReturned: toInt(
        typeof response.numberreturned === 'string' ? response.numberreturned : undefined,
        Number.NaN,
      ),
      totalMatches: toInt(
        typeof response.totalmatches === 'string' ? response.totalmatches : undefined,
        Number.NaN,
      ),
      items: await parseBrowseItems(typeof result === 'string' ? result : undefined),
    };
  }

  /** Browses every page of `objectId`. */
  async browseAll(objectId: string): Promise<BrowseItem[]> {
    const items: BrowseItem[] = [];
    let startIndex = 0;

    for (;;) {
      const chunk = await this.browse(objectId, startIndex, 0);
      if (!Array.isArray(chunk.items) || Number.isNaN(chunk.totalMatches)) {
        throw new Error('browse() returned an invalid payload');
      }

      items.push(...chunk.items);
      startIndex = chunk.startIndex + chunk.numberReturned;
      if (chunk.numberReturned === 0 || startIndex >= chunk.totalMatches) {
        return items;
      }
    }
  }

  async getQueue(limit = 0, offset = 0): Promise<BrowseItem[]> {
    if (!limit) {
      return this.browseAll(QUEUE_OBJECT_ID);
    }

    return (await this.browse(QUEUE_OBJECT_ID, offset, limit)).items;
  }

  // --- former prototype files ------------------------------------------------------------------

  nightMode(enable: boolean): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, {
      eqType: 'NightMode',
      value: enable ? '1' : '0',
    });
  }

  speechEnhancement(enable: boolean): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, {
      eqType: 'DialogLevel',
      value: enable ? '1' : '0',
    });
  }

  subEnable(): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, { eqType: 'SubEnable', value: 1 });
  }

  subDisable(): Promise<void> {
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, { eqType: 'SubEnable', value: 0 });
  }

  subGain(value: number): Promise<void> {
    if (value < -15 || value > 15) {
      return Promise.reject(new RangeError('Valid range is between -15 and 15'));
    }

    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, { eqType: 'SubGain', value });
  }

  subCrossover(value: number): Promise<void> {
    if (value < 40 || value > 200) {
      return Promise.reject(
        new RangeError("You shouldn't use unreasonable values, you risk damaging the SUB"),
      );
    }

    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, { eqType: 'SubCrossover', value });
  }

  subPolarity(polarity: number): Promise<void> {
    const value = polarity === SUB_POLARITY.INVERSE ? SUB_POLARITY.INVERSE : SUB_POLARITY.NONE;
    return this.#invoke(RENDERING_CONTROL, SOAP_ACTIONS.SetEQ, { eqType: 'SubPolarity', value });
  }

  /** Recomputes the group volume from the members and emits `group-volume` (debounced 100 ms). */
  recalculateGroupVolume(): void {
    const zone = this.system.zones.find((candidate) => candidate.uuid === this.uuid);
    if (!zone) {
      return;
    }

    const volumes = zone.members
      .filter((member) => !member.outputFixed)
      .map((member) => member.state.volume);
    if (volumes.length === 0) {
      return;
    }

    const total = volumes.reduce((sum, volume) => sum + volume, 0);
    this.#previousGroupVolume ??= this.groupState.volume;
    this.groupState.volume = Math.round(total / zone.members.length);

    clearTimeout(this.#groupVolumeTimer);
    this.#groupVolumeTimer = setTimeout(() => {
      const event: GroupVolumeEvent = {
        uuid: this.uuid,
        oldVolume: this.#previousGroupVolume ?? this.groupState.volume,
        newVolume: this.groupState.volume,
        roomName: this.roomName,
      };
      this.emit('group-volume', event);
      this.system.emit('group-volume', event);
      this.#groupVolumeTimer = undefined;
      this.#previousGroupVolume = undefined;
    }, 100);
  }

  /** Sets the volume of the whole group, scaling each member proportionally (or by a delta). */
  async setGroupVolume(desiredVolume: number | string): Promise<void> {
    const currentGroupVolume = this.groupState.volume;
    const text = String(desiredVolume);
    let target: number;
    let delta: number;
    if (/^[+-]/.test(text)) {
      delta = toInt(text);
      target = currentGroupVolume + delta;
    } else {
      target = toInt(text);
      delta = target - currentGroupVolume;
    }

    const zone = this.system.zones.find((candidate) => candidate.uuid === this.uuid);
    if (!zone) {
      throw new Error(`${this.roomName} is not the coordinator of a group`);
    }

    const updates = zone.members.map((member) => {
      let memberTarget: number;
      if (target < 1) {
        memberTarget = 0;
      } else if (delta > 0) {
        memberTarget = member.state.volume + delta;
      } else {
        const factor = member.state.volume / currentGroupVolume;
        memberTarget = Math.ceil(factor * target);
      }

      // Update the internal state right away so a following recalculation sees it.
      member.#state.volume = memberTarget;
      return member.setVolume(memberTarget);
    });

    this.groupState.volume = target;
    await Promise.all(updates);
  }

  /** Replaces what is playing with a favorite; radio favorites play directly, others via the queue. */
  async replaceWithFavorite(favoriteName: string): Promise<void> {
    this.#logger.debug({ room: this.roomName, favoriteName }, 'replacing with favorite');
    const favorites = await this.system.getFavorites();
    const wanted = favoriteName.toLowerCase();
    const favorite = favorites.find(
      (candidate) =>
        candidate.title?.toLowerCase() === wanted || candidate.uri.toLowerCase() === wanted,
    );
    if (!favorite) {
      throw new Error('Favorite not found');
    }

    let target: { uri: string; metadata?: string } = favorite;
    if (getUriType(favorite.uri) !== URI_TYPE.RADIO) {
      await this.clearQueue();
      await this.addURIToQueue(favorite.uri, favorite.metadata);
      target = { uri: `x-rincon-queue:${this.uuid}#0` };
    }

    if (this.avTransportUri === target.uri) {
      this.#logger.debug({ room: this.roomName, uri: target.uri }, 'already the current transport');
      return;
    }

    await this.setAVTransport(target.uri, target.metadata);
  }

  /** Replaces the queue with a saved Sonos playlist and plays from it. */
  async replaceWithPlaylist(playlistName: string): Promise<void> {
    this.#logger.debug({ room: this.roomName, playlistName }, 'replacing with playlist');
    const playlists = await this.system.getPlaylists();
    const wanted = playlistName.toLowerCase();
    const playlist = playlists.find((candidate) => candidate.title?.toLowerCase() === wanted);
    if (!playlist) {
      throw new Error('Playlist not found');
    }

    await this.clearQueue();
    await this.addURIToQueue(playlist.uri, '');
    await this.setAVTransport(`x-rincon-queue:${this.uuid}#0`, '');
  }
}
