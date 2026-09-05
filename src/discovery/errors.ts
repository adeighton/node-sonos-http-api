export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export class UnknownServiceError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(`Unknown music service '${serviceName}'`);
    this.name = 'UnknownServiceError';
    this.serviceName = serviceName;
  }
}

export class RequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RequestError';
  }
}

export class RequestTimeoutError extends RequestError {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** A favorite, playlist or similar item the caller named does not exist on the system. */
export class ItemNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemNotFoundError';
  }
}

/** The command only works on the coordinator of a group, and this player is not one. */
export class NotCoordinatorError extends Error {
  constructor(roomName: string) {
    super(`${roomName} is not the coordinator of a group`);
    this.name = 'NotCoordinatorError';
  }
}

/** Meanings of the UPnP AVTransport / ContentDirectory error codes players answer with. */
export const UPNP_ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = Object.freeze({
  401: 'Invalid action',
  402: 'Invalid arguments',
  501: 'Action failed',
  600: 'Argument value invalid',
  701: 'Transition not available: the player cannot do that in its current state',
  702: 'No contents',
  703: 'Read error',
  704: 'Format not supported for playback',
  705: 'Transport is locked',
  706: 'Write error',
  707: 'Media is protected or not writable',
  708: 'Format not supported for recording',
  709: 'Media is full',
  710: 'Seek mode not supported',
  711: 'Illegal seek target: no such track or position',
  712: 'Play mode not supported',
  713: 'Record quality not supported',
  714: 'Illegal MIME type',
  715: 'Content is busy',
  716: 'Resource not found',
  717: 'Play speed not supported',
  718: 'Invalid instance id',
  737: 'No DNS server',
  738: 'Bad domain name',
  739: 'Server error',
  800: 'Command not allowed for this player (usually: it is not the group coordinator)',
});

export class RequestFailedError extends RequestError {
  readonly url: string;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly body: string;

  constructor(url: string, statusCode: number, statusMessage: string, body: string) {
    super(`Got status ${statusCode} when invoking ${url}`);
    this.name = 'RequestFailedError';
    this.url = url;
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.body = body;
  }
}

/** A SOAP fault from a player: the command was understood but refused, with a UPnP error code. */
export class SoapFaultError extends RequestFailedError {
  readonly action: string;
  readonly errorCode: number;
  readonly errorDescription: string;

  constructor(
    url: string,
    action: string,
    errorCode: number,
    errorDescription: string,
    body: string,
  ) {
    super(url, 500, 'Internal Server Error', body);
    this.name = 'SoapFaultError';
    this.action = action;
    this.errorCode = errorCode;
    this.errorDescription = errorDescription;
    this.message = `${action} was rejected by the player: UPnP error ${errorCode} (${errorDescription})`;
  }
}

const FAULT_CODE = /<errorCode>\s*(\d+)\s*<\/errorCode>/;
const FAULT_DESCRIPTION = /<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/;

/** Turns a failed SOAP request into a SoapFaultError when the body carries a UPnP fault. */
export function toSoapFault(error: RequestFailedError, action: string): RequestFailedError {
  const code = FAULT_CODE.exec(error.body);
  if (!code) {
    return error;
  }

  const errorCode = Number.parseInt(code[1] ?? '', 10);
  const description =
    FAULT_DESCRIPTION.exec(error.body)?.[1] ||
    UPNP_ERROR_DESCRIPTIONS[errorCode] ||
    'no description';
  return new SoapFaultError(error.url, action, errorCode, description, error.body);
}
