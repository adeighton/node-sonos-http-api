import { ArgumentError, UnknownServiceError } from '../discovery/errors.ts';

/** An error that maps to a specific HTTP status code. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(400, message, options);
    this.name = 'BadRequestError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(404, message, options);
    this.name = 'NotFoundError';
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(503, message, options);
    this.name = 'ServiceUnavailableError';
  }
}

/** The status code a thrown value should produce. Input and lookup errors are the client's fault. */
export function statusForError(error: unknown): number {
  if (error instanceof HttpError) {
    return error.status;
  }

  if (
    error instanceof ArgumentError ||
    error instanceof UnknownServiceError ||
    error instanceof URIError ||
    error instanceof RangeError
  ) {
    return 400;
  }

  return 500;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
}

export interface ErrorBody {
  status: 'error';
  error: string;
}

/** The JSON body clients receive for a failure; never includes a stack trace. */
export function errorBody(error: unknown): ErrorBody {
  return { status: 'error', error: errorMessage(error) };
}
