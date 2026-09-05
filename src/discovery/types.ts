import type { PlayMode } from './player-state.ts';

/** One `<ZoneGroupMember>` as parsed from ZoneGroupState (attribute names are lowercased). */
export interface ZoneMemberData {
  uuid: string;
  location: string;
  zonename: string;
  invisible?: string;
  channelmapset?: string;
  htsatchanmapset?: string;
  [attribute: string]: string | undefined;
}

/** One `<ZoneGroup>` as parsed from ZoneGroupState. */
export interface ZoneGroupData {
  $name?: string;
  $attrs: { coordinator: string; id: string };
  zonegroupmember: ZoneMemberData | ZoneMemberData[];
}

export interface PresetPlayer {
  roomName: string;
  volume?: number | string;
  mute?: boolean;
}

/** The preset shape understood by `applyPreset` (also what presets/*.json files contain). */
export interface Preset {
  players: PresetPlayer[];
  pauseOthers?: boolean;
  playMode?: Partial<PlayMode>;
  uri?: string;
  metadata?: string;
  favorite?: string;
  playlist?: string;
  trackNo?: number;
  elapsedTime?: number;
  sleep?: number;
  state?: string;
}

export interface AvailableService {
  id: number;
  capabilities: number;
  type: number;
}

/** An entry from a ContentDirectory Browse (queue item, favorite, playlist, ...). */
export interface BrowseItem {
  uri: string;
  title?: string;
  artist?: string;
  album?: string;
  albumTrackNumber?: string;
  albumArtUri?: string | string[];
  metadata?: string;
}

export interface BrowseResult {
  startIndex: number;
  numberReturned: number;
  totalMatches: number;
  items: BrowseItem[];
}

/** An attribute-only element such as `<TransportState val="PLAYING"/>`. */
export interface ValueNode {
  val?: string;
}

export interface ChannelValueNode extends ValueNode {
  channel?: string;
}

/** The `<InstanceID>` node of an AVTransport / RenderingControl LastChange event. */
export interface LastChangeData {
  $name?: string;
  $attrs?: Record<string, string>;
  transportstate?: ValueNode;
  currentplaymode?: ValueNode;
  currentcrossfademode?: ValueNode;
  currenttrack?: ValueNode;
  currenttrackmetadata?: ValueNode;
  'r:nexttrackmetadata'?: ValueNode;
  'r:enqueuedtransporturimetadata'?: ValueNode;
  avtransporturi?: ValueNode;
  avtransporturimetadata?: ValueNode;
  mute?: ChannelValueNode | ChannelValueNode[];
  volume?: ChannelValueNode | ChannelValueNode[];
  outputfixed?: ValueNode;
  subgain?: ValueNode;
  subcrossover?: ValueNode;
  subpolarity?: ValueNode;
  subenabled?: ValueNode;
  bass?: ValueNode;
  treble?: ValueNode;
  dialoglevel?: ValueNode;
  nightmode?: ValueNode;
  loudness?: ChannelValueNode;
  [other: string]: unknown;
}
