import type { Readable } from 'node:stream';

import { ArgumentError, RequestFailedError, toSoapFault } from './errors.ts';
import type { HttpStreamResponse, StreamHttpClient } from './http.ts';
import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import { XML_ARRAYS, firstXmlTag } from './xml.ts';
import type { XmlNode } from './xml.ts';

export const SOAP_ACTIONS = {
  SetEQ: 'urn:schemas-upnp-org:service:RenderingControl:1#SetEQ',
  Play: 'urn:schemas-upnp-org:service:AVTransport:1#Play',
  Pause: 'urn:schemas-upnp-org:service:AVTransport:1#Pause',
  Stop: 'urn:schemas-upnp-org:service:AVTransport:1#Stop',
  Next: 'urn:schemas-upnp-org:service:AVTransport:1#Next',
  Previous: 'urn:schemas-upnp-org:service:AVTransport:1#Previous',
  Mute: 'urn:schemas-upnp-org:service:RenderingControl:1#SetMute',
  GroupMute: 'urn:schemas-upnp-org:service:GroupRenderingControl:1#SetGroupMute',
  Volume: 'urn:schemas-upnp-org:service:RenderingControl:1#SetVolume',
  Seek: 'urn:schemas-upnp-org:service:AVTransport:1#Seek',
  RemoveAllTracksFromQueue: 'urn:schemas-upnp-org:service:AVTransport:1#RemoveAllTracksFromQueue',
  RemoveTrackFromQueue: 'urn:schemas-upnp-org:service:AVTransport:1#RemoveTrackFromQueue',
  RemoveTrackRangeFromQueue: 'urn:schemas-upnp-org:service:AVTransport:1#RemoveTrackRangeFromQueue',
  ReorderTracksInQueue: 'urn:schemas-upnp-org:service:AVTransport:1#ReorderTracksInQueue',
  SaveQueue: 'urn:schemas-upnp-org:service:AVTransport:1#SaveQueue',
  SetPlayMode: 'urn:schemas-upnp-org:service:AVTransport:1#SetPlayMode',
  SetCrossfadeMode: 'urn:schemas-upnp-org:service:AVTransport:1#SetCrossfadeMode',
  GetPositionInfo: 'urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo',
  ConfigureSleepTimer: 'urn:schemas-upnp-org:service:AVTransport:1#ConfigureSleepTimer',
  SetAVTransportURI: 'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
  Browse: 'urn:schemas-upnp-org:service:ContentDirectory:1#Browse',
  BecomeCoordinatorOfStandaloneGroup:
    'urn:schemas-upnp-org:service:AVTransport:1#BecomeCoordinatorOfStandaloneGroup',
  RefreshShareIndex: 'urn:schemas-upnp-org:service:ContentDirectory:1#RefreshShareIndex',
  AddURIToQueue: 'urn:schemas-upnp-org:service:AVTransport:1#AddURIToQueue',
  AddMultipleURIsToQueue: 'urn:schemas-upnp-org:service:AVTransport:1#AddMultipleURIsToQueue',
  ListAvailableServices: 'urn:schemas-upnp-org:service:MusicServices:1#ListAvailableServices',
  SetTreble: 'urn:schemas-upnp-org:service:RenderingControl:1#SetTreble',
  SetBass: 'urn:schemas-upnp-org:service:RenderingControl:1#SetBass',
} as const;

export type SoapAction = (typeof SOAP_ACTIONS)[keyof typeof SOAP_ACTIONS];

/* prettier-ignore */
export const SOAP_TEMPLATES: Readonly<Record<SoapAction, string>> = Object.freeze({
  [SOAP_ACTIONS.SetEQ]: '<u:SetEQ xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><EQType>{eqType}</EQType><DesiredValue>{value}</DesiredValue></u:SetEQ>',
  [SOAP_ACTIONS.Play]: '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>',
  [SOAP_ACTIONS.Pause]: '<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Pause>',
  [SOAP_ACTIONS.Stop]: '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Stop>',
  [SOAP_ACTIONS.Next]: '<u:Next xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Next>',
  [SOAP_ACTIONS.Previous]: '<u:Previous xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Previous>',
  [SOAP_ACTIONS.Mute]: '<u:SetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>{mute}</DesiredMute></u:SetMute>',
  [SOAP_ACTIONS.GroupMute]: '<u:SetGroupMute xmlns:u="urn:schemas-upnp-org:service:GroupRenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>{mute}</DesiredMute></u:SetGroupMute>',
  [SOAP_ACTIONS.Volume]: '<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{volume}</DesiredVolume></u:SetVolume>',
  [SOAP_ACTIONS.Seek]: '<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Unit>{unit}</Unit><Target>{value}</Target></u:Seek>',
  [SOAP_ACTIONS.RemoveAllTracksFromQueue]: '<u:RemoveAllTracksFromQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>',
  [SOAP_ACTIONS.RemoveTrackFromQueue]: '<u:RemoveTrackFromQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><ObjectID>Q:0/{track}</ObjectID></u:RemoveTrackFromQueue>',
  [SOAP_ACTIONS.RemoveTrackRangeFromQueue]: '<u:RemoveTrackRangeFromQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><UpdateID>0</UpdateID><StartingIndex>{startIndex}</StartingIndex><NumberOfTracks>{numberOfTracks}</NumberOfTracks></u:RemoveTrackRangeFromQueue>',
  [SOAP_ACTIONS.ReorderTracksInQueue]: '<u:ReorderTracksInQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><UpdateID>0</UpdateID><StartingIndex>{startIndex}</StartingIndex><NumberOfTracks>{numberOfTracks}</NumberOfTracks><InsertBefore>{insertBefore}</InsertBefore></u:ReorderTracksInQueue>',
  [SOAP_ACTIONS.SaveQueue]: '<u:SaveQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Title>{title}</Title><ObjectID></ObjectID></u:SaveQueue>',
  [SOAP_ACTIONS.SetPlayMode]: '<u:SetPlayMode xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><NewPlayMode>{playMode}</NewPlayMode></u:SetPlayMode>',
  [SOAP_ACTIONS.SetCrossfadeMode]: '<u:SetCrossfadeMode xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CrossfadeMode>{crossfadeMode}</CrossfadeMode></u:SetCrossfadeMode>',
  [SOAP_ACTIONS.GetPositionInfo]: '<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>',
  [SOAP_ACTIONS.ConfigureSleepTimer]: '<u:ConfigureSleepTimer xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><NewSleepTimerDuration>{time}</NewSleepTimerDuration></u:ConfigureSleepTimer>',
  [SOAP_ACTIONS.SetAVTransportURI]: '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>{uri}</CurrentURI><CurrentURIMetaData>{metadata}</CurrentURIMetaData></u:SetAVTransportURI>',
  [SOAP_ACTIONS.Browse]: '<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>{objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter /><StartingIndex>{startIndex}</StartingIndex><RequestedCount>{limit}</RequestedCount><SortCriteria /></u:Browse>',
  [SOAP_ACTIONS.BecomeCoordinatorOfStandaloneGroup]: '<u:BecomeCoordinatorOfStandaloneGroup xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:BecomeCoordinatorOfStandaloneGroup>',
  [SOAP_ACTIONS.RefreshShareIndex]: '<u:RefreshShareIndex xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><AlbumArtistDisplayOption></AlbumArtistDisplayOption></u:RefreshShareIndex>',
  [SOAP_ACTIONS.AddURIToQueue]: '<u:AddURIToQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><EnqueuedURI>{uri}</EnqueuedURI><EnqueuedURIMetaData>{metadata}</EnqueuedURIMetaData><DesiredFirstTrackNumberEnqueued>{desiredFirstTrackNumberEnqueued}</DesiredFirstTrackNumberEnqueued><EnqueueAsNext>{enqueueAsNext}</EnqueueAsNext></u:AddURIToQueue>',
  [SOAP_ACTIONS.AddMultipleURIsToQueue]: '<u:AddMultipleURIsToQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><UpdateID>0</UpdateID><NumberOfURIs>{amount}</NumberOfURIs><EnqueuedURIs>{uris}</EnqueuedURIs><EnqueuedURIsMetaData>{metadatas}</EnqueuedURIsMetaData><ContainerURI>{containerURI}</ContainerURI><ContainerMetaData>{containerMetadata}</ContainerMetaData><DesiredFirstTrackNumberEnqueued>{desiredFirstTrackNumberEnqueued}</DesiredFirstTrackNumberEnqueued><EnqueueAsNext>{enqueueAsNext}</EnqueueAsNext></u:AddMultipleURIsToQueue>',
  [SOAP_ACTIONS.ListAvailableServices]: '<u:ListAvailableServices xmlns:u="urn:schemas-upnp-org:service:MusicServices:1"></u:ListAvailableServices>',
  [SOAP_ACTIONS.SetTreble]: '<u:SetTreble xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><DesiredTreble>{level}</DesiredTreble></u:SetTreble>',
  [SOAP_ACTIONS.SetBass]: '<u:SetBass xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><DesiredBass>{level}</DesiredBass></u:SetBass>',
});

export type SoapValues = Record<string, string | number>;

/**
 * Builds the SOAP envelope for `action`, substituting `{placeholder}` tokens verbatim.
 * Callers are responsible for XML-escaping values (see Player.setAVTransport / saveQueue).
 */
export function buildSoapEnvelope(action: SoapAction, values?: SoapValues): string {
  const template = (SOAP_TEMPLATES as Record<string, string | undefined>)[action];
  if (template === undefined) {
    throw new ArgumentError(`Unknown SOAP action ${action}`);
  }

  const body = values
    ? template.replace(/{([a-z]+)}/gi, (match, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : match,
      )
    : template;

  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${body}</s:Body></s:Envelope>`;
}

/**
 * Parses a SOAP response: the single element inside `<s:Body>` with its attributes removed,
 * e.g. `{ track: '31', reltime: '0:02:22', ... }` for GetPositionInfoResponse.
 */
export async function parseSoapResponse(input: Readable | HttpStreamResponse): Promise<XmlNode> {
  const stream = 'stream' in input ? input.stream : input;
  const body = await firstXmlTag(stream, 's:body', { preserveMarkup: XML_ARRAYS.NEVER });
  if (!body) {
    return {};
  }

  const { $name: _name, $attrs: _attrs, ...children } = body;
  const keys = Object.keys(children);
  if (keys.length !== 1) {
    return {};
  }

  const result = children[keys[0] as string];
  if (typeof result !== 'object' || result === null) {
    return {};
  }

  const { $attrs: _resultAttrs, ...fields } = result as XmlNode;
  return fields;
}

export interface SoapClient {
  invoke(url: string, action: SoapAction, values?: SoapValues): Promise<HttpStreamResponse>;
  parse(input: Readable | HttpStreamResponse): Promise<XmlNode>;
}

export function createSoapClient(
  httpRequest: StreamHttpClient,
  logger: Logger = silentLogger,
): SoapClient {
  return {
    async invoke(url, action, values) {
      const envelope = buildSoapEnvelope(action, values);
      logger.trace({ url, action }, 'invoking soap action');
      const body = Buffer.from(envelope, 'utf8');

      let response: HttpStreamResponse;
      try {
        response = await httpRequest({
          url,
          method: 'POST',
          headers: {
            'CONTENT-TYPE': 'text/xml; charset="utf-8"',
            SOAPACTION: `"${action}"`,
            'CONTENT-LENGTH': body.length,
          },
          body,
          type: 'stream',
        });
      } catch (error) {
        if (error instanceof RequestFailedError) {
          throw toSoapFault(error, action.slice(action.indexOf('#') + 1));
        }

        throw error;
      }

      logger.trace({ url, action, status: response.status }, 'soap action answered');
      return response;
    },
    parse: parseSoapResponse,
  };
}
