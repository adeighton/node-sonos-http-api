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

export class RequestFailedError extends RequestError {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly body: string;

  constructor(url: string, statusCode: number, statusMessage: string, body: string) {
    super(`Got status ${statusCode} when invoking ${url}`);
    this.name = 'RequestFailedError';
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.body = body;
  }
}
