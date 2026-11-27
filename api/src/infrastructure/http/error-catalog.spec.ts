import { HttpException } from '@nestjs/common';
import type { ApplicationError } from '../../application/errors';
import type { DomainError } from '../../domain/errors';
import {
  CatalogHttpException,
  ERROR_CATALOG,
  type ErrorCode,
  envelopeFor,
  toHttpException,
} from './error-catalog';

type KnownError = ApplicationError | DomainError;
type KnownKind = KnownError['kind'];

// The 17 codes and statuses of the design (Error Handling section).
const DESIGN_TABLE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  INVALID_SIGNATURE: 401,
  FORBIDDEN_ORIGIN: 403,
  PRODUCT_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  DELIVERY_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  IDEMPOTENCY_KEY_IN_PROGRESS: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_KEY_REUSED: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  PAYMENT_PROVIDER_ERROR: 502,
};

// One sample value and the expected catalog code per kind. The Record type forces an entry for
// every kind of ApplicationError and DomainError, so a new kind without a mapper arm fails to compile.
const KIND_CASES: Readonly<Record<KnownKind, { error: KnownError; code: ErrorCode }>> = {
  REPOSITORY_ERROR: {
    error: { kind: 'REPOSITORY_ERROR', reason: 'ServiceError' },
    code: 'INTERNAL_ERROR',
  },
  VALIDATION_ERROR: {
    error: { kind: 'VALIDATION_ERROR', details: [{ field: 'quantity', rule: 'min' }] },
    code: 'VALIDATION_ERROR',
  },
  MISSING_IDEMPOTENCY_KEY: {
    error: { kind: 'MISSING_IDEMPOTENCY_KEY' },
    code: 'MISSING_IDEMPOTENCY_KEY',
  },
  IDEMPOTENCY_KEY_REUSED: {
    error: { kind: 'IDEMPOTENCY_KEY_REUSED' },
    code: 'IDEMPOTENCY_KEY_REUSED',
  },
  IDEMPOTENCY_KEY_IN_PROGRESS: {
    error: { kind: 'IDEMPOTENCY_KEY_IN_PROGRESS' },
    code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
  },
  PRODUCT_NOT_FOUND: { error: { kind: 'PRODUCT_NOT_FOUND' }, code: 'PRODUCT_NOT_FOUND' },
  CUSTOMER_NOT_FOUND: { error: { kind: 'CUSTOMER_NOT_FOUND' }, code: 'CUSTOMER_NOT_FOUND' },
  TRANSACTION_NOT_FOUND: {
    error: { kind: 'TRANSACTION_NOT_FOUND' },
    code: 'TRANSACTION_NOT_FOUND',
  },
  DELIVERY_NOT_FOUND: { error: { kind: 'DELIVERY_NOT_FOUND' }, code: 'DELIVERY_NOT_FOUND' },
  PAYMENT_PROVIDER_ERROR: {
    error: { kind: 'PAYMENT_PROVIDER_ERROR' },
    code: 'PAYMENT_PROVIDER_ERROR',
  },
  INSUFFICIENT_STOCK: {
    error: { kind: 'INSUFFICIENT_STOCK', available: 2 },
    code: 'INSUFFICIENT_STOCK',
  },
  INVALID_TRANSITION: {
    error: { kind: 'INVALID_TRANSITION', from: 'APPROVED', to: 'PENDING' },
    code: 'INTERNAL_ERROR',
  },
  INVALID_AMOUNTS: { error: { kind: 'INVALID_AMOUNTS' }, code: 'INTERNAL_ERROR' },
  INVALID_REFERENCE: { error: { kind: 'INVALID_REFERENCE' }, code: 'INTERNAL_ERROR' },
};

// Codes that no use-case or domain kind produces yet. They are produced by the origin guard,
// the router, the body parser, the content-type guard, the rate limiter or the webhook.
const CODES_WITHOUT_KIND: readonly ErrorCode[] = [
  'INVALID_SIGNATURE',
  'FORBIDDEN_ORIGIN',
  'ROUTE_NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'TOO_MANY_REQUESTS',
];

describe('ERROR_CATALOG', () => {
  it('contains exactly the 17 codes of the design', () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(Object.keys(DESIGN_TABLE).sort());
    expect(Object.keys(ERROR_CATALOG)).toHaveLength(17);
  });

  it.each(Object.entries(DESIGN_TABLE))('maps %s to status %i', (code, status) => {
    expect(ERROR_CATALOG[code as ErrorCode].status).toBe(status);
  });

  it.each(Object.keys(DESIGN_TABLE) as ErrorCode[])(
    'gives %s a non-empty fixed English message without placeholders',
    (code) => {
      const { message } = ERROR_CATALOG[code];

      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/[{}$]/);
    },
  );

  it('builds an envelope with exactly the four keys', () => {
    expect(envelopeFor('ROUTE_NOT_FOUND')).toEqual({
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found.',
      details: [],
    });
  });
});

describe('toHttpException', () => {
  it('has a case for every kind: each kind maps to its expected status and envelope', () => {
    for (const [kind, { error, code }] of Object.entries(KIND_CASES)) {
      const exception = toHttpException(error);

      expect({ kind, status: exception.getStatus() }).toEqual({
        kind,
        status: ERROR_CATALOG[code].status,
      });
      expect(exception.getResponse()).toEqual(
        expect.objectContaining({ code, statusCode: ERROR_CATALOG[code].status }),
      );
    }
  });

  it.each(Object.entries(KIND_CASES))(
    '%s returns a CatalogHttpException whose body is the fixed catalog message',
    (_kind, { error, code }) => {
      const exception = toHttpException(error);

      expect(exception).toBeInstanceOf(HttpException);
      expect(exception).toBeInstanceOf(CatalogHttpException);
      expect(exception.getResponse()).toEqual({
        statusCode: ERROR_CATALOG[code].status,
        code,
        message: ERROR_CATALOG[code].message,
        details: expect.any(Array),
      });
    },
  );

  it('answers REPOSITORY_ERROR with 500 and never includes the reason', () => {
    const exception = toHttpException({ kind: 'REPOSITORY_ERROR', reason: 'SecretLeak' });

    expect(exception.getStatus()).toBe(500);
    expect(JSON.stringify(exception.getResponse())).not.toContain('SecretLeak');
    expect(exception.kind).toBe('REPOSITORY_ERROR');
  });

  it('answers an unknown kind (added without a mapper arm) with 500 INTERNAL_ERROR', () => {
    const unknown = { kind: 'FUTURE_KIND' } as unknown as KnownError;
    const exception = toHttpException(unknown);

    expect(exception.getStatus()).toBe(500);
    expect(exception.getResponse()).toEqual(envelopeFor('INTERNAL_ERROR'));
    expect(exception.kind).toBe('FUTURE_KIND');
  });

  it('lists each validation failure as "field: rule" in details', () => {
    const exception = toHttpException({
      kind: 'VALIDATION_ERROR',
      details: [
        { field: 'quantity', rule: 'min' },
        { field: 'delivery.phone', rule: 'pattern' },
      ],
    });

    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: ['quantity: min', 'delivery.phone: pattern'],
    });
  });

  it('does not echo the available units of INSUFFICIENT_STOCK in the message', () => {
    const exception = toHttpException({ kind: 'INSUFFICIENT_STOCK', available: 7 });

    expect(exception.getResponse()).toEqual(envelopeFor('INSUFFICIENT_STOCK'));
    expect(JSON.stringify(exception.getResponse())).not.toContain('7');
  });

  it('gives every code that has no kind yet a catalog entry', () => {
    for (const code of CODES_WITHOUT_KIND) {
      expect(ERROR_CATALOG[code]).toBeDefined();
    }
  });
});
