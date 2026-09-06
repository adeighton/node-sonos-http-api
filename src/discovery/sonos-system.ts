import { EventEmitter } from 'node:events';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { applyPreset } from './apply-preset.ts';
import type { PresetSystem } from './apply-preset.ts';
import { UnknownServiceError } from './errors.ts';
import { createHttpClient } from './http.ts';
import type { StreamHttpClient } from './http.ts';
import { createArtLookup } from './music-services.ts';
import type { ArtLookup } from './music-services.ts';
import { NotificationListener } from './notification-listener.ts';
import type { NotificationEvents } from './notification-listener.ts';
import { parseServices } from './parse-services.ts';
import { Player } from './player.ts';
import type { PlayerDeps, PlayerSystem, SonosSystemEvents, Zone } from './player.ts';
import { SOAP_ACTIONS, createSoapClient } from './soap.ts';
import type { SoapClient } from './soap.ts';
import { Ssdp } from './ssdp.ts';
import type { SsdpFound } from './ssdp.ts';
import { Subscriber } from './subscriber.ts';
import type {
  AvailableService,
  BrowseItem,
  Preset,
  ZoneGroupData,
  ZoneMemberData,
} from './types.ts';
import { asArray } from './xml.ts';

export interface SonosSystemOptions {
  /** Only accept players from this household id (for homes with several Sonos systems). */
  household?: string;
  /**
   * Player IPs to contact directly, for networks where SSDP multicast cannot reach the players
   * (VLANs, Docker). Discovery still listens to SSDP as well.
   */
  discoveryHosts?: string[];
  soundcloudClientId?: string;
}

export interface SsdpLike {
  start(): void;
  stop(): void;
  once(event: 'found', handler: (found: SsdpFound) => void): unknown;
  off(event: 'found', handler: (found: SsdpFound) => void): unknown;
}

/** What the system needs from a NotificationListener (the class satisfies it; tests use fakes). */
export interface ListenerLike extends Pick<EventEmitter<NotificationEvents>, 'on'> {
  readonly endpoint: string;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export interface TopologySubscriberLike {
  dispose(): Promise<void> | void;
  once(event: 'dead', handler: (reason: string) => void): unknown;
}

export interface SonosSystemDeps {
  ssdp?: SsdpLike;
  http?: StreamHttpClient;
  soap?: SoapClient;
  artLookup?: ArtLookup;
  createListener?: (localEndpoint: string) => ListenerLike;
  createSubscriber?: (subscribeUrl: string, notificationUrl: string) => TopologySubscriberLike;
  createPlayer?: (
    data: ZoneMemberData,
    notificationEndpoint: string,
    system: PlayerSystem,
    deps: PlayerDeps,
  ) => Player;
  logger?: Logger;
}

const PLAYER_PORT = 1400;
const SEED_RETRY_MS = 5000;

function isVisible(member: ZoneMemberData): boolean {
  // invisible == 1 marks BRIDGE, BOOST, SUB and the right channel of a stereo pair.
  return member.invisible !== '1';
}

/**
 * Discovers the Sonos system on the LAN and keeps its topology and players current.
 *
 * Lifecycle: `start()` scans with SSDP → the first player's device description reveals which local
 * interface reaches the players → a NotificationListener is opened on it → a ZoneGroupTopology
 * subscription feeds `topology-change`; every player then subscribes to its own events and the
 * listener routes NOTIFY bodies to the right Player by uuid.
 */
/** The coordinator uuid encoded in a zone group id (`RINCON_...01400:3630835724`). */
export function coordinatorFromGroupId(id: string | undefined): string {
  return id?.split(':')[0] ?? '';
}

export class SonosSystem
  extends EventEmitter<SonosSystemEvents>
  implements PlayerSystem, PresetSystem
{
  players: Player[] = [];
  zones: Zone[] = [];
  localEndpoint = '0.0.0.0';
  availableServices: Record<string, AvailableService> = {};

  readonly #options: SonosSystemOptions;
  readonly #logger: Logger;
  readonly #ssdp: SsdpLike;
  readonly #http: StreamHttpClient;
  readonly #soap: SoapClient;
  readonly #artLookup: ArtLookup;
  readonly #createListener: (localEndpoint: string) => ListenerLike;
  readonly #createSubscriber: SonosSystemDeps['createSubscriber'] & object;
  readonly #createPlayer: SonosSystemDeps['createPlayer'] & object;
  readonly #players = new Map<string, Player>();
  #listener: ListenerLike | undefined;
  #topologySubscriber: TopologySubscriberLike | undefined;
  #anyPlayerIndex = 0;
  #started = false;
  #disposed = false;
  #initializing = false;
  #restartCount = 0;
  #seedTimer: NodeJS.Timeout | undefined;
  readonly #onFound = (found: SsdpFound): void => {
    void this.#init(found);
  };

  constructor(options: SonosSystemOptions = {}, deps: SonosSystemDeps = {}) {
    super();
    this.#options = options;
    this.#logger = deps.logger ?? silentLogger;
    this.#ssdp = deps.ssdp ?? new Ssdp({ logger: this.#logger });
    this.#http = deps.http ?? createHttpClient();
    this.#soap = deps.soap ?? createSoapClient(this.#http, this.#logger);
    this.#artLookup =
      deps.artLookup ??
      createArtLookup({ logger: this.#logger, soundcloudClientId: options.soundcloudClientId });
    this.#createListener =
      deps.createListener ??
      ((localEndpoint) => new NotificationListener(localEndpoint, { logger: this.#logger }));
    this.#createSubscriber =
      deps.createSubscriber ??
      ((subscribeUrl, notificationUrl) =>
        new Subscriber(subscribeUrl, notificationUrl, {
          http: this.#http,
          logger: this.#logger,
        }));
    this.#createPlayer =
      deps.createPlayer ??
      ((data, notificationEndpoint, system, playerDeps) =>
        new Player(data, notificationEndpoint, system, playerDeps));
  }

  /** Begins discovery. Safe to call once; later calls are ignored. */
  start(): void {
    if (this.#started || this.#disposed) {
      return;
    }

    this.#started = true;
    this.#restart();
  }

  /** Stops discovery, unsubscribes from every player and closes the notification listener. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    clearTimeout(this.#seedTimer);
    this.#ssdp.off('found', this.#onFound);
    this.#ssdp.stop();
    await this.#teardown();
  }

  getPlayer(roomName: string): Player | undefined {
    const wanted = roomName.toLowerCase();
    return this.players.find((player) => player.roomName.toLowerCase() === wanted);
  }

  getPlayerByUUID(uuid: string): Player | undefined {
    return this.players.find((player) => player.uuid === uuid);
  }

  /** Any player, round-robin; `undefined` before the topology is known. */
  getAnyPlayer(): Player | undefined {
    if (this.players.length === 0) {
      return undefined;
    }

    return this.players[this.#anyPlayerIndex++ % this.players.length];
  }

  getServiceId(serviceName: string): number {
    return this.#requireService(serviceName).id;
  }

  getServiceType(serviceName: string): number {
    return this.#requireService(serviceName).type;
  }

  applyPreset(preset: Preset): Promise<void> {
    return applyPreset(this, preset, this.#logger);
  }

  async getFavorites(): Promise<BrowseItem[]> {
    return this.#requireAnyPlayer().browseAll('FV:2');
  }

  async getPlaylists(): Promise<BrowseItem[]> {
    return this.#requireAnyPlayer().browseAll('SQ:');
  }

  async refreshShareIndex(): Promise<void> {
    return this.#requireAnyPlayer().refreshShareIndex();
  }

  #requireService(serviceName: string): AvailableService {
    const service = this.availableServices[serviceName];
    if (!service) {
      throw new UnknownServiceError(serviceName);
    }

    return service;
  }

  #requireAnyPlayer(): Player {
    const player = this.getAnyPlayer();
    if (!player) {
      throw new Error('No Sonos players have been discovered yet');
    }

    return player;
  }

  #restart(): void {
    if (this.#disposed) {
      return;
    }

    void this.#teardown();
    this.localEndpoint = '0.0.0.0';
    this.players = [];
    this.zones = [];
    this.availableServices = {};
    this.#ssdp.start();
    this.#ssdp.once('found', this.#onFound);
    this.#seedDiscoveryHosts();
  }

  /** Contacts the configured discovery hosts directly; retries are spaced out after a failure. */
  #seedDiscoveryHosts(): void {
    const hosts = this.#options.discoveryHosts ?? [];
    clearTimeout(this.#seedTimer);
    if (hosts.length === 0) {
      return;
    }

    const seed = (): void => {
      this.#seedTimer = undefined;
      for (const host of hosts) {
        void this.#init(
          {
            ip: host,
            location: `http://${host}:${PLAYER_PORT}/xml/device_description.xml`,
            household: undefined,
          },
          true,
        );
      }
    };

    // The first attempt runs right away; later ones (after a failure) are spaced out.
    const firstAttempt = this.#restartCount === 0;
    this.#restartCount += 1;
    if (firstAttempt) {
      seed();
    } else {
      this.#seedTimer = setTimeout(seed, SEED_RETRY_MS);
    }
  }

  async #teardown(): Promise<void> {
    const listener = this.#listener;
    const subscriber = this.#topologySubscriber;
    const players = [...this.#players.values()];
    this.#listener = undefined;
    this.#topologySubscriber = undefined;
    this.#players.clear();

    await Promise.all([
      subscriber?.dispose(),
      ...players.map((player) => player.dispose()),
      listener?.close(),
    ]);
  }

  async #init(found: SsdpFound, trusted = false): Promise<void> {
    if (this.#disposed || this.#initializing || this.#listener) {
      return;
    }

    if (
      !trusted &&
      this.#options.household !== undefined &&
      found.household !== this.#options.household
    ) {
      this.#logger.debug({ household: found.household }, 'ignoring player from another household');
      this.#ssdp.once('found', this.#onFound);
      return;
    }

    this.#ssdp.stop();
    this.#initializing = true;

    try {
      const response = await this.#http({ url: found.location, method: 'GET', type: 'stream' });
      response.stream.resume();
      this.localEndpoint = response.localAddress ?? '0.0.0.0';

      const listener = this.#createListener(this.localEndpoint);
      this.#listener = listener;
      listener.on('queue-change', (uuid) => {
        const player = this.getPlayerByUUID(uuid);
        if (player) {
          this.emit('queue-change', player);
        }
      });
      listener.on('list-change', (type) => this.emit('list-change', type));
      listener.on('topology', (_uuid, zoneGroups) => this.#topologyChange(zoneGroups));
      listener.on('last-change', (uuid, data) => {
        void this.#players.get(uuid)?.handleLastChange(data);
      });
      listener.on('group-mute', (uuid, mute) => this.#players.get(uuid)?.handleGroupMute(mute));
      await listener.listen();

      this.#logger.debug({ ip: found.ip }, 'subscribing to topology events');
      const subscriber = this.#createSubscriber(
        `http://${found.ip}:${PLAYER_PORT}/ZoneGroupTopology/Event`,
        listener.endpoint,
      );
      this.#topologySubscriber = subscriber;
      subscriber.once('dead', (reason) => {
        this.#logger.error({ reason }, 'topology subscription died, restarting discovery');
        this.#restart();
      });
    } catch (error) {
      this.#logger.error({ err: error, location: found.location }, 'discovery failed, retrying');
      this.#restart();
    } finally {
      this.#initializing = false;
    }
  }

  #getOrCreatePlayer(data: ZoneMemberData): Player {
    const existing = this.#players.get(data.uuid);
    if (existing) {
      return existing;
    }

    const listener = this.#listener;
    if (!listener) {
      throw new Error('Cannot create players before the notification listener is up');
    }

    const player = this.#createPlayer(data, listener.endpoint, this, {
      soap: this.#soap,
      artLookup: this.#artLookup,
      logger: this.#logger,
      createSubscriber: this.#createSubscriber,
    });
    this.#players.set(data.uuid, player);
    return player;
  }

  /**
   * Sonos names the coordinator twice: in the `Coordinator` attribute and again as the prefix of
   * the group id (`<uuid>:<counter>`). While a group is being formed the attribute can arrive
   * empty, and the id is then the only trustworthy source.
   */
  #coordinatorUuid(group: ZoneGroupData): string {
    return group.$attrs.coordinator || coordinatorFromGroupId(group.$attrs.id);
  }

  #topologyChange(zoneGroups: ZoneGroupData[]): void {
    const players: Player[] = [];
    const zones: Zone[] = [];

    for (const group of zoneGroups) {
      const visibleMembers = asArray(group.zonegroupmember).filter(isVisible);
      if (visibleMembers.length === 0) {
        continue;
      }

      const members = visibleMembers.map((member) => this.#getOrCreatePlayer(member));
      const coordinatorUuid = this.#coordinatorUuid(group);
      const coordinator =
        members.find((member) => member.uuid === coordinatorUuid) ??
        this.#players.get(coordinatorUuid) ??
        members[0];
      if (!coordinator) {
        continue;
      }

      if (coordinator.uuid !== coordinatorUuid) {
        // An arbitrary member is a poor coordinator: commands sent to it are refused with UPnP
        // error 800, so say what happened rather than letting the group quietly misbehave.
        this.#logger.warn(
          { group: group.$attrs.id, coordinator: coordinatorUuid, fallback: coordinator.roomName },
          'group coordinator is not a visible player, using the first member instead',
        );
      } else if (coordinatorUuid !== group.$attrs.coordinator) {
        this.#logger.debug(
          { group: group.$attrs.id, coordinator: coordinator.roomName },
          'group reported no coordinator, taking it from the group id',
        );
      }

      for (const member of members) {
        member.coordinator = coordinator;
      }

      players.push(...members);
      // The resolved coordinator, never the raw attribute: an empty uuid here would keep
      // setGroupVolume and the announcement restore from finding the zone again.
      zones.push({ coordinator, members, uuid: coordinator.uuid, id: group.$attrs.id });
    }

    const present = new Set(players.map((player) => player.uuid));
    for (const [uuid, player] of this.#players) {
      if (!present.has(uuid)) {
        this.#logger.info({ room: player.roomName }, 'player left the system');
        this.#players.delete(uuid);
        void player.dispose();
      }
    }

    this.zones = zones;
    this.players = players;
    this.emit('topology-change', zones);
    void this.#refreshAvailableServices();
  }

  async #refreshAvailableServices(): Promise<void> {
    const player = this.getAnyPlayer();
    if (!player) {
      return;
    }

    try {
      const response = await this.#soap.invoke(
        `${player.baseUrl}/MusicServices/Control`,
        SOAP_ACTIONS.ListAvailableServices,
      );
      const parsed = await this.#soap.parse(response);
      const list = parsed.availableservicedescriptorlist;
      const services = await parseServices(typeof list === 'string' ? list : '');
      const firstTime = Object.keys(this.availableServices).length === 0;
      this.availableServices = services;
      if (firstTime) {
        setImmediate(() => this.emit('initialized'));
      }
    } catch (error) {
      this.#logger.warn({ err: error, room: player.roomName }, 'could not list music services');
    }
  }
}
