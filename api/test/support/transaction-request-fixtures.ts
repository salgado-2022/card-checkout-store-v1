import * as fc from 'fast-check';
import request from 'supertest';
import { COLOMBIAN_DEPARTMENTS } from '../../src/infrastructure/http/dto/create-transaction.dto';
import { TRANSACTION_PRODUCT, type TransactionsHttpApp } from './transactions-http-app';

export const TRANSACTION_PATH = '/api/v1/transactions';
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const SEEDED_PRODUCT_ID = TRANSACTION_PRODUCT.id;

export type PlainBody = Record<string, unknown>;

/** Valid `POST /transactions` bodies with generated values. Every field satisfies its DTO rule. */
export const validTransactionBodyArbitrary: fc.Arbitrary<PlainBody> = fc.record({
  productId: fc.constant(SEEDED_PRODUCT_ID),
  quantity: fc.integer({ min: 1, max: 5 }),
  customerId: fc.constant('cust-1'),
  delivery: fc.record({
    recipientName: fc.stringMatching(/^[A-Za-z]{3,20}$/),
    phone: fc.stringMatching(/^3\d{9}$/),
    addressLine1: fc.stringMatching(/^[A-Za-z0-9]{5,30}$/),
    city: fc.stringMatching(/^[A-Za-z]{2,20}$/),
    department: fc.constantFrom(...COLOMBIAN_DEPARTMENTS),
  }),
  payment: fc.record({
    cardToken: fc.stringMatching(/^[A-Za-z0-9_]{8,40}$/),
    installments: fc.integer({ min: 1, max: 36 }),
    brand: fc.constantFrom('VISA', 'MASTERCARD'),
    lastFour: fc.stringMatching(/^\d{4}$/),
  }),
  acceptanceToken: fc.stringMatching(/^[A-Za-z0-9_]{8,40}$/),
  acceptPersonalAuth: fc.stringMatching(/^[A-Za-z0-9_]{8,40}$/),
});

/** Idempotency-Key values that satisfy the 8 to 128 character rule. */
export const validIdempotencyKeyArbitrary: fc.Arbitrary<string> =
  fc.stringMatching(/^[A-Za-z0-9._-]{8,128}$/);

/** Returns a deep copy of `body` with `value` stored at `path`. */
export function withField(body: PlainBody, path: readonly string[], value: unknown): PlainBody {
  const clone = structuredClone(body);
  let target: PlainBody = clone;
  for (const key of path.slice(0, -1)) {
    target = target[key] as PlainBody;
  }
  target[path[path.length - 1] ?? ''] = value;
  return clone;
}

/** Sends `bodyText` as the raw JSON text. A `null` key sends no Idempotency-Key header at all. */
export function postTransaction(
  testApp: TransactionsHttpApp,
  bodyText: string,
  key: string | null,
): request.Test {
  const req = request(testApp.app.getHttpServer())
    .post(TRANSACTION_PATH)
    .set('Content-Type', 'application/json');
  if (key !== null) {
    req.set(IDEMPOTENCY_KEY_HEADER, key);
  }
  return req.send(bodyText);
}

/** Asserts that a rejected request left no trace in any fake: no rows, no gateway call, no stock change. */
export function expectNoTransactionWrites(testApp: TransactionsHttpApp): void {
  expect(testApp.transactions.count()).toBe(0);
  expect(testApp.deliveries.count()).toBe(0);
  expect(testApp.gateway.callLog).toEqual([]);
  expect(testApp.products.stockOf(SEEDED_PRODUCT_ID)).toBe(TRANSACTION_PRODUCT.stock);
}
