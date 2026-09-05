import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { describe, it } from 'node:test';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { fakeSoapClient } from './fake-soap.ts';
import { fixturePath } from './fixtures.ts';

describe('fakeSoapClient', () => {
  it('records calls and answers with an empty parseable body by default', async () => {
    const soap = fakeSoapClient();

    const response = await soap.invoke('http://p/Control', SOAP_ACTIONS.Play);

    assert.deepEqual(soap.callArgs(0), ['http://p/Control', SOAP_ACTIONS.Play, undefined]);
    assert.deepEqual(await soap.parse(response), {});
  });

  it('serves queued fixture responses and failures in order', async () => {
    const soap = fakeSoapClient();
    soap.queueResponse(createReadStream(fixturePath('addURIToQueue.xml')));
    soap.queueFailure(new Error('boom'));

    const first = await soap.invoke('http://p/Control', SOAP_ACTIONS.AddURIToQueue, { uri: 'x' });
    assert.equal((await soap.parse(first)).numtracksadded, '1');
    await assert.rejects(soap.invoke('http://p/Control', SOAP_ACTIONS.Play), /boom/);
    assert.throws(() => soap.callArgs(5), /no soap call at index 5/);
  });
});
