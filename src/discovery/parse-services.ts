import type { AvailableService } from './types.ts';
import { XML_ARRAYS, parseXmlEvents } from './xml.ts';

/**
 * Parses the `AvailableServiceDescriptorList` XML returned by MusicServices#ListAvailableServices
 * into a map of service name → id / capabilities / Sonos service type.
 */
export async function parseServices(xml: string): Promise<Record<string, AvailableService>> {
  const services: Record<string, AvailableService> = {};

  await parseXmlEvents(
    xml,
    {
      service: (service) => {
        const attrs = service.$attrs ?? {};
        const name = attrs.name;
        if (name === undefined) {
          return;
        }

        const id = Number.parseInt(attrs.id ?? '', 10);
        services[name] = {
          id,
          capabilities: Number.parseInt(attrs.capabilities ?? '', 10),
          // The "service type" Sonos expects in URIs is the id shifted by 8 bits plus 7.
          type: (id << 8) + 7,
        };
      },
    },
    { preserveMarkup: XML_ARRAYS.NEVER },
  );

  return services;
}
