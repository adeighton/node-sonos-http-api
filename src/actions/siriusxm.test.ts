import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { ActionRegistry } from './registry.ts';
import {
  findSiriusChannel,
  registerSiriusXmActions,
  siriusXmMetadata,
  siriusXmUri,
} from './siriusxm.ts';

describe('siriusxm action', () => {
  it('finds channels by number or fuzzy name', () => {
    const byNumber = findSiriusChannel('9');
    assert.ok(byNumber);
    assert.equal(byNumber.channelNum, '9');
    const byName = findSiriusChannel('bbc world');
    assert.ok(byName);
    assert.match(byName.title, /BBC World/i);
    assert.equal(siriusXmUri(byName), `x-sonosapi-hls:r%3a${byName.id}?sid=37&flags=8480&sn=11`);
    assert.match(
      siriusXmMetadata(byName),
      new RegExp(`id="00092120r%3a${byName.id}" parentID="${byName.parentID}"`),
    );
    assert.match(siriusXmMetadata(byName), /object\.item\.audioItem\.audioBroadcast/);
  });

  it('plays the best match and lists channels and stations', async () => {
    const registry = new ActionRegistry();
    registerSiriusXmActions(registry);
    const { context, rooms } = createActionContext();
    const kitchen = rooms.get('Kitchen');
    assert.ok(kitchen);
    const siriusxm = registry.get('siriusxm');
    assert.ok(siriusxm);

    const result = (await siriusxm(context, ['bbc world'])) as { status: string; channel: string };
    assert.equal(result.status, 'success');
    assert.match(result.channel, /BBC World/i);
    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [SOAP_ACTIONS.SetAVTransportURI, SOAP_ACTIONS.Play],
    );
    assert.match(String(kitchen.soap.calls[0]?.values?.uri), /^x-sonosapi-hls:r%3a.*sid=37/);

    const channels = (await siriusxm(context, ['channels'])) as string[];
    assert.ok(channels.length > 100);
    assert.ok(Number(channels[0]) < Number(channels[1]));
    const stations = (await siriusxm(context, ['stations'])) as string[];
    assert.equal(stations.length, channels.length);
    assert.ok(stations[0] && stations[1] && stations[0].localeCompare(stations[1]) <= 0);

    await assert.rejects(siriusxm(context, ['zzzzqqqq']), NotFoundError);
    await assert.rejects(siriusxm(context, []), BadRequestError);
  });
});
