import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it, mock } from 'node:test';

import { fixturePath } from '../testing/fixtures.ts';
import { ArgumentError } from './errors.ts';
import type { HttpRequestOptions, HttpStreamResponse } from './http.ts';
import {
  SOAP_ACTIONS,
  SOAP_TEMPLATES,
  buildSoapEnvelope,
  createSoapClient,
  parseSoapResponse,
} from './soap.ts';
import type { SoapAction } from './soap.ts';

function streamResponse(stream: Readable): HttpStreamResponse {
  return {
    status: 200,
    statusMessage: 'OK',
    headers: {},
    localAddress: '127.0.0.1',
    stream,
  };
}

describe('createSoapClient', () => {
  it('invokes the soap call with the correct request and returns the response', async () => {
    const response = streamResponse(Readable.from([]));
    const httpRequest = mock.fn((_options: HttpRequestOptions) => Promise.resolve(response));
    const soap = createSoapClient(httpRequest);

    const result = await soap.invoke('http://127.0.0.1/test/path', SOAP_ACTIONS.SetEQ, {
      eqType: 'SubGain',
      value: -2,
    });

    assert.equal(result, response);
    assert.equal(httpRequest.mock.callCount(), 1);
    assert.deepEqual(httpRequest.mock.calls[0]?.arguments[0], {
      url: 'http://127.0.0.1/test/path',
      method: 'POST',
      headers: {
        'CONTENT-TYPE': 'text/xml; charset="utf-8"',
        SOAPACTION: '"urn:schemas-upnp-org:service:RenderingControl:1#SetEQ"',
        'CONTENT-LENGTH': 312,
      },
      body: Buffer.from(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetEQ xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><EQType>SubGain</EQType><DesiredValue>-2</DesiredValue></u:SetEQ></s:Body></s:Envelope>',
      ),
      type: 'stream',
    });
  });

  it('supports calls without values', async () => {
    const httpRequest = mock.fn((_options: HttpRequestOptions) =>
      Promise.resolve(streamResponse(Readable.from([]))),
    );
    const soap = createSoapClient(httpRequest);

    await soap.invoke('http://127.0.0.1/test/path', SOAP_ACTIONS.Play);

    assert.deepEqual(httpRequest.mock.calls[0]?.arguments[0], {
      url: 'http://127.0.0.1/test/path',
      method: 'POST',
      headers: {
        'CONTENT-TYPE': 'text/xml; charset="utf-8"',
        SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#Play"',
        'CONTENT-LENGTH': 266,
      },
      body: Buffer.from(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>',
      ),
      type: 'stream',
    });
  });

  it('propagates http failures', async () => {
    const httpRequest = mock.fn(() => Promise.reject(new Error('unreachable')));
    const soap = createSoapClient(httpRequest);

    await assert.rejects(soap.invoke('http://127.0.0.1/x', SOAP_ACTIONS.Play), /unreachable/);
  });
});

describe('buildSoapEnvelope', () => {
  it('has a template for every action', () => {
    for (const [name, action] of Object.entries(SOAP_ACTIONS)) {
      assert.ok(SOAP_TEMPLATES[action], name);
    }
  });

  it('leaves unknown placeholders untouched and substitutes numbers', () => {
    const envelope = buildSoapEnvelope(SOAP_ACTIONS.Seek, { unit: 'TRACK_NR' });
    assert.ok(envelope.includes('<Unit>TRACK_NR</Unit><Target>{value}</Target>'));

    const volume = buildSoapEnvelope(SOAP_ACTIONS.Volume, { volume: 7 });
    assert.ok(volume.includes('<DesiredVolume>7</DesiredVolume>'));
  });

  it('rejects unknown actions', () => {
    const unknownAction: string = 'urn:nope#Nothing';
    assert.throws(
      () => buildSoapEnvelope(unknownAction as SoapAction),
      (error: unknown) => error instanceof ArgumentError,
    );
  });
});

describe('parseSoapResponse', () => {
  it('returns the response fields without attributes', async () => {
    const result = await parseSoapResponse(createReadStream(fixturePath('addURIToQueue.xml')));

    assert.deepEqual(result, {
      firsttracknumberenqueued: '1',
      newqueuelength: '1',
      numtracksadded: '1',
    });
  });

  it('accepts an http stream response and keeps text fields intact', async () => {
    const result = await parseSoapResponse(
      streamResponse(createReadStream(fixturePath('getpositioninfo.xml'))),
    );

    assert.equal(result.track, '31');
    assert.equal(result.reltime, '0:02:22');
    assert.ok(String(result.trackmetadata).startsWith('<DIDL-Lite'));
  });

  it('returns an empty object when there is no body or it has no single child', async () => {
    assert.deepEqual(await parseSoapResponse(Readable.from([])), {});
    assert.deepEqual(
      await parseSoapResponse(
        Readable.from(['<s:Envelope><s:Body><a/><b/></s:Body></s:Envelope>']),
      ),
      {},
    );
  });
});
