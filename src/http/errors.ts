import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import {
  ArgumentError,
  ItemNotFoundError,
  NotCoordinatorError,
  RequestFailedError,
  RequestTimeoutError,
  UnknownServiceError,
} from '../discovery/errors.ts';

export type HttpStatus = ContentfulStatusCode;

/** An error that maps to a specific HTTP status code. */
export class HttpError extends Error {
  readonly status: HttpStatus;

  constructor(status: HttpStatus, message: string, options?: ErrorOptions) {
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

/** The player (or an upstream music service) answered, but refused or failed the request. */
export class BadGatewayError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(502, message, options);
    this.name = 'BadGatewayError';
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(503, message, options);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * The status code a thrown value should produce. Input and lookup errors are the client's fault
 * (4xx); a player refusing or not answering a command is reported as a gateway problem (502 / 504)
 * so that 500 is left for genuine bugs in this server.
 */
export function statusForError(error: unknown): HttpStatus {
  if (error instanceof HttpError) {
    return error.status;
  }

  if (error instanceof HTTPException) {
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

  if (error instanceof ItemNotFoundError) {
    return 404;
  }

  if (error instanceof NotCoordinatorError) {
    return 409;
  }

  if (error instanceof RequestTimeoutError) {
    return 504;
  }

  if (error instanceof RequestFailedError) {
    return 502;
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
