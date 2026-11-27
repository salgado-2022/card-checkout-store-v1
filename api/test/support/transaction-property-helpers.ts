import * as fc from 'fast-check';
import request from 'supertest';
import { requestHash, type JsonValue } from '../../src/application/request-hash';
import type { PaymentCreateResponse } from '../../src/application/ports/payment-gateway';
import type { TransactionStatus } from '../../src/domain/transaction-status';
import { FakeIdGenerator } from './fake-id-generator';
import { TRANSACTION_PRODUCT, type TransactionsHttpApp } from './transactions-http-app';

export const NUM_RUNS = 25;
export const PROPERTY_TIMEOUT_MS = 60_000;
/** Lambda timeout: a record older than this is stale (see in-memory-idempotency-repository). */
export const STALE_AFTER_MS = 25_000;
export const TRANSACTIONS_PATH = '/api/v1/transactions';
export const BASE_FEE_IN_CENTS = 300_000;
export const DELIVERY_FEE_IN_CENTS = 800_000;
export const PROVIDER_EXTERNAL_ID = 'ext-test-0001';
export const FIXED_KEY = 'test-key-0001';
export const OTHER_KEY = 'test-key-0002';

export interface TransactionBody {
  productId: string;
  quantity: number;
  customerId: string;
  delivery: {
    recipientName: string;
    phone: string;
    addressLine1: string;
    city: string;
    department: string;
  };
  payment: {
    cardToken: string;
    installments: number;
    brand: 'VISA' | 'MASTERCARD';
    lastFour: string;
  };
  acceptanceToken: string;
  acceptPersonalAuth: string;
}

export const idempotencyKeyArbitrary = fc.stringMatching(/^[A-Za-z0-9._-]{8,64}$/);

/** Valid bodies for product `prod-1` (price in TRANSACTION_PRODUCT) and customer `cust-1`. */
export const transactionBodyArbitrary: fc.Arbitrary<TransactionBody> = fc.record({
  productId: fc.constant('prod-1'),
  quantity: fc.integer({ min: 1, max: 5 }),
  customerId: fc.constant('cust-1'),
  delivery: fc.record({
    recipientName: fc.stringMatching(/^[A-Za-z]{3,20}$/),
    phone: fc.stringMatching(/^3[0-9]{9}$/),
    addressLine1: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{4,30}$/),
    city: fc.constantFrom('Bogotá', 'Medellín'),
    department: fc.constantFrom('Bogotá D.C.', 'Antioquia'),
  }),
  payment: fc.record({
    cardToken: fc.stringMatching(/^tok_[a-z0-9]{8,32}$/),
    installments: fc.integer({ min: 1, max: 36 }),
    brand: fc.constantFrom<'VISA' | 'MASTERCARD'>('VISA', 'MASTERCARD'),
    lastFour: fc.stringMatching(/^[0-9]{4}$/),
  }),
  acceptanceToken: fc.stringMatching(/^acc_[a-z0-9]{4,24}$/),
  acceptPersonalAuth: fc.stringMatching(/^auth_[a-z0-9]{4,24}$/),
});

export const providerStatusArbitrary = fc.constantFrom<TransactionStatus>(
  'PENDING',
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
);

/** Free text the provider may send as a message; no leading or trailing blanks. */
export const providerMessageArbitrary = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,38}[A-Za-z]$/);

/** Short error codes such as the provider rejection codes the adapter keeps in `providerMessage`. */
export const providerCodeArbitrary = fc.stringMatching(/^[A-Z_]{3,24}$/);

export function totalFor(quantity: number): number {
  return quantity * TRANSACTION_PRODUCT.priceInCents + BASE_FEE_IN_CENTS + DELIVERY_FEE_IN_CENTS;
}

/** The first Reference a fresh app generates: the use case takes its first ULID for it. */
export function referenceOfFirstAttempt(): string {
  return `ORD-${new FakeIdGenerator().ulid()}`;
}

/** A provider answer whose amount, currency and reference match the stored Transaction. */
export function providerAnswer(
  status: TransactionStatus,
  quantity: number,
  overrides: Partial<PaymentCreateResponse> = {},
): PaymentCreateResponse {
  return {
    externalId: PROVIDER_EXTERNAL_ID,
    status,
    message: null,
    amountInCents: totalFor(quantity),
    currency: 'COP',
    reference: referenceOfFirstAttempt(),
    ...overrides,
  };
}

/** `null` sends no Idempotency-Key header at all. */
export function postTransaction(
  testApp: TransactionsHttpApp,
  body: object,
  key: string | null = FIXED_KEY,
): request.Test {
  const req = request(testApp.app.getHttpServer())
    .post(TRANSACTIONS_PATH)
    .set('Content-Type', 'application/json');
  if (key !== null) {
    req.set('Idempotency-Key', key);
  }
  return req.send(body);
}

/** Same body with a different installments value: a canonically different request. */
export function withOtherInstallments(body: TransactionBody): TransactionBody {
  return {
    ...body,
    payment: { ...body.payment, installments: body.payment.installments === 1 ? 2 : 1 },
  };
}

/** Stores an IN_PROGRESS record for `key` and `body`, created at the fake clock's current instant. */
export async function seedInProgressRecord(
  testApp: TransactionsHttpApp,
  key: string,
  body: TransactionBody,
): Promise<void> {
  const seeded = await testApp.idempotency.begin(
    key,
    requestHash(toJson(body)),
    testApp.clock.now(),
  );
  if (seeded.isErr()) {
    throw new Error('test setup: the idempotency record could not be seeded');
  }
}

export function toJson(body: TransactionBody): JsonValue {
  return JSON.parse(JSON.stringify(body)) as JsonValue;
}
