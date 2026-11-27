import { HttpException } from '@nestjs/common';
import type { ApplicationError } from '../../application/errors';
import type { DomainError } from '../../domain/errors';

// Single enumeration of every error code the API can return. The mapper, the exception filter,
// the origin guard and the OpenAPI script all read from here. Messages are fixed literals: they
// never contain request data, stack traces or SDK messages.
export const ERROR_CATALOG = {
  VALIDATION_ERROR: { status: 400, message: 'Request validation failed.' },
  MISSING_IDEMPOTENCY_KEY: { status: 400, message: 'The Idempotency-Key header is required.' },
  INVALID_SIGNATURE: { status: 401, message: 'Invalid signature.' },
  FORBIDDEN_ORIGIN: { status: 403, message: 'Origin not allowed.' },
  PRODUCT_NOT_FOUND: { status: 404, message: 'Product not found.' },
  CUSTOMER_NOT_FOUND: { status: 404, message: 'Customer not found.' },
  TRANSACTION_NOT_FOUND: { status: 404, message: 'Transaction not found.' },
  DELIVERY_NOT_FOUND: { status: 404, message: 'Delivery not found.' },
  ROUTE_NOT_FOUND: { status: 404, message: 'Route not found.' },
  INSUFFICIENT_STOCK: { status: 409, message: 'Not enough stock for the requested quantity.' },
  IDEMPOTENCY_KEY_IN_PROGRESS: {
    status: 409,
    message: 'A request with this Idempotency-Key is still in progress.',
  },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request body too large.' },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: 'Unsupported media type. Use application/json.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    message: 'The Idempotency-Key was already used with a different request body.',
  },
  TOO_MANY_REQUESTS: { status: 429, message: 'Too many requests.' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error.' },
  PAYMENT_PROVIDER_ERROR: {
    status: 502,
    message: 'The payment provider could not process the request.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface ErrorEnvelope {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details: string[];
}

export function envelopeFor(code: ErrorCode, details: string[] = []): ErrorEnvelope {
  const { status, message } = ERROR_CATALOG[code];
  return { statusCode: status, code, message, details };
}

/**
 * HttpException whose response body is the catalog envelope. `kind` is the source error kind
 * (for example `REPOSITORY_ERROR`) and is only used by the server-side log, never in the body.
 */
export class CatalogHttpException extends HttpException {
  constructor(
    readonly envelope: ErrorEnvelope,
    readonly kind?: string,
  ) {
    super(envelope, envelope.statusCode);
  }
}

function fail(code: ErrorCode, kind: string, details: string[] = []): CatalogHttpException {
  return new CatalogHttpException(envelopeFor(code, details), kind);
}

/** Maps a use-case or domain error to its HTTP exception. Pure: no I/O, no logging. */
export function toHttpException(err: ApplicationError | DomainError): CatalogHttpException {
  switch (err.kind) {
    case 'VALIDATION_ERROR':
      return fail(
        'VALIDATION_ERROR',
        err.kind,
        err.details.map((detail) => `${detail.field}: ${detail.rule}`),
      );
    case 'MISSING_IDEMPOTENCY_KEY':
      return fail('MISSING_IDEMPOTENCY_KEY', err.kind);
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return fail('IDEMPOTENCY_KEY_IN_PROGRESS', err.kind);
    case 'IDEMPOTENCY_KEY_REUSED':
      return fail('IDEMPOTENCY_KEY_REUSED', err.kind);
    case 'PRODUCT_NOT_FOUND':
      return fail('PRODUCT_NOT_FOUND', err.kind);
    case 'CUSTOMER_NOT_FOUND':
      return fail('CUSTOMER_NOT_FOUND', err.kind);
    case 'TRANSACTION_NOT_FOUND':
      return fail('TRANSACTION_NOT_FOUND', err.kind);
    case 'DELIVERY_NOT_FOUND':
      return fail('DELIVERY_NOT_FOUND', err.kind);
    case 'PAYMENT_PROVIDER_ERROR':
      return fail('PAYMENT_PROVIDER_ERROR', err.kind);
    case 'INSUFFICIENT_STOCK':
      // The message stays a fixed literal; the available units travel in `details` as "field: rule".
      return fail('INSUFFICIENT_STOCK', err.kind, [`quantity: available=${err.available}`]);
    case 'REPOSITORY_ERROR':
    case 'INVALID_TRANSITION':
    case 'INVALID_AMOUNTS':
    case 'INVALID_REFERENCE':
      // These cannot happen with valid input; reaching them is a server bug.
      return fail('INTERNAL_ERROR', err.kind);
    default: {
      // Unknown kind at runtime (a kind added without a mapper arm). Exhaustiveness is checked above.
      const unknown: never = err;
      return fail('INTERNAL_ERROR', String((unknown as { kind?: unknown }).kind));
    }
  }
}
