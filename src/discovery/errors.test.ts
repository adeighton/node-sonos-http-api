import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ArgumentError,
  ItemNotFoundError,
  NotCoordinatorError,
  RequestError,
  RequestFailedError,
  RequestTimeoutError,
  SoapFaultError,
  UPNP_ERROR_DESCRIPTIONS,
  UnknownServiceError,
  toSoapFault,
} from './errors.ts';

const FAULT_BODY =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>711</errorCode><errorDescription>Illegal seek target</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';

describe('discovery errors', () => {
  it('ArgumentError carries its name and message', () => {
    const error = new ArgumentError('bad input');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ArgumentError');
    assert.equal(error.message, 'bad input');
  });

  it('UnknownServiceError remembers the service name', () => {
    const error = new UnknownServiceError('Tidal');
    assert.equal(error.name, 'UnknownServiceError');
    assert.equal(error.serviceName, 'Tidal');
    assert.match(error.message, /Tidal/);
  });

  it('request errors form a hierarchy', () => {
    const timeout = new RequestTimeoutError('http://192.168.1.1:1400/x', 10);
    const failed = new RequestFailedError('http://192.168.1.1:1400/x', 500, 'Boom', '<fault/>');

    assert.ok(timeout instanceof RequestError);
    assert.ok(failed instanceof RequestError);
    assert.equal(timeout.name, 'RequestTimeoutError');
    assert.match(timeout.message, /timed out after 10 ms/);
    assert.equal(failed.name, 'RequestFailedError');
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.statusMessage, 'Boom');
    assert.equal(failed.body, '<fault/>');
    assert.match(failed.message, /Got status 500/);
  });

  it('RequestError supports a cause', () => {
    const cause = new Error('socket hang up');
    const error = new RequestError('wrapped', { cause });
    assert.equal(error.cause, cause);
  });
});

describe('toSoapFault', () => {
  it('reads the UPnP error code and description from a fault body', () => {
    const failed = new RequestFailedError(
      'http://p:1400/x',
      500,
      'Internal Server Error',
      FAULT_BODY,
    );

    const fault = toSoapFault(failed, 'Seek');

    assert.ok(fault instanceof SoapFaultError);
    assert.ok(fault instanceof RequestFailedError);
    assert.equal(fault.name, 'SoapFaultError');
    assert.equal(fault.action, 'Seek');
    assert.equal(fault.errorCode, 711);
    assert.equal(fault.errorDescription, 'Illegal seek target');
    assert.equal(fault.url, 'http://p:1400/x');
    assert.equal(fault.body, FAULT_BODY);
    assert.equal(
      fault.message,
      'Seek was rejected by the player: UPnP error 711 (Illegal seek target)',
    );
  });

  it('falls back to the known meaning of the code, then to a placeholder', () => {
    const known = toSoapFault(
      new RequestFailedError('u', 500, '', '<errorCode>701</errorCode>'),
      'Play',
    ) as SoapFaultError;
    assert.equal(known.errorDescription, UPNP_ERROR_DESCRIPTIONS[701]);
    assert.match(known.message, /701 \(Transition not available/);

    const unknown = toSoapFault(
      new RequestFailedError('u', 500, '', '<errorCode>999</errorCode>'),
      'Play',
    ) as SoapFaultError;
    assert.equal(unknown.errorDescription, 'no description');
  });

  it('leaves failures without a fault body untouched', () => {
    const failed = new RequestFailedError('u', 404, 'Not Found', 'nope');
    assert.equal(toSoapFault(failed, 'Play'), failed);
  });

  it('names the lookup and coordinator errors', () => {
    assert.equal(new ItemNotFoundError('Favorite not found').name, 'ItemNotFoundError');
    const coordinator = new NotCoordinatorError('Kitchen');
    assert.equal(coordinator.name, 'NotCoordinatorError');
    assert.equal(coordinator.message, 'Kitchen is not the coordinator of a group');
  });
});
