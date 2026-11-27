import * as fc from 'fast-check';
import request from 'supertest';
import type { PaymentCreateResponse } from '../../../application/ports/payment-gateway';
import { ok } from 'neverthrow';
import type { TransactionStatus } from '../../../domain/transaction-status';
import {
  createRecordingTransactionsApp,
  type RecordingTransactionsApp,
} from '../../../../test/support/recording-transactions-app';
import {
  TRANSACTION_CUSTOMER,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';

// Feature: payments-api, Property 13: PENDING persistence happens before any Provider call
// Validates: Requirements 5.11, 6.3, 6.8

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const PATH = '/api/v1/transactions';

// Steps that must all run, in this order, before the gateway is called.
const REQUIRED_BEFORE_CHARGE = [
  'idempotency.begin',
  'delivery.create',
  'transaction.create',
  'idempotency.attachTransactionId',
] as const;

const PROVIDER_STATUSES: readonly TransactionStatus[] = ['PENDING', 'APPROVED', 'DECLINED'];

const caseArbitrary = fc.record({
  quantity: fc.integer({ min: 1, max: 5 }),
  installments: fc.integer({ min: 1, max: 36 }),
  brand: fc.constantFrom('VISA', 'MASTERCARD'),
  providerStatus: fc.constantFrom(...PROVIDER_STATUSES),
  cardToken: fc.stringMatching(/^[a-z][a-z0-9]{15,31}$/),
});

interface Case {
  readonly quantity: number;
  readonly installments: number;
  readonly brand: 'VISA' | 'MASTERCARD';
  readonly providerStatus: TransactionStatus;
  readonly cardToken: string;
}

function bodyFor(input: Case) {
  return {
    productId: TRANSACTION_PRODUCT.id,
    quantity: input.quantity,
    customerId: TRANSACTION_CUSTOMER.id,
    delivery: {
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 # 2-3',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
    },
    payment: {
      cardToken: input.cardToken,
      installments: input.installments,
      brand: input.brand,
      lastFour: '4242',
    },
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  };
}

// Sends two requests to the same app so the second one proves a fresh Reference per request.
async function runCase(input: Case): Promise<void> {
  const testApp: RecordingTransactionsApp = await createRecordingTransactionsApp({
    reply: (request) =>
      ok<PaymentCreateResponse, never>({
        externalId: `ext-${request.reference}`,
        status: input.providerStatus,
        message: null,
        amountInCents: request.amountInCents,
        currency: request.currency,
        reference: request.reference,
      }),
  });
  try {
    const first = await send(testApp, 'idem-key-0013-a', input);
    const second = await send(testApp, 'idem-key-0013-b', input);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // Split the global log at each gateway call: the steps before a call belong to that request.
    const names = testApp.steps.names();
    // Each request starts at its own `idempotency.begin` and ends at its gateway call. The steps
    // between them are that request's writes; the trailing steps of the previous request are skipped.
    const chargeIndexes = names.flatMap((name, index) =>
      name === 'gateway.create' ? [index] : [],
    );
    const beginIndexes = names.flatMap((name, index) =>
      name === 'idempotency.begin' ? [index] : [],
    );
    expect(chargeIndexes).toHaveLength(2);
    expect(beginIndexes).toHaveLength(2);

    for (const [index, chargeAt] of chargeIndexes.entries()) {
      const segment = names.slice(beginIndexes[index] ?? 0, chargeAt);
      expect(segment.slice(0, REQUIRED_BEFORE_CHARGE.length)).toEqual([...REQUIRED_BEFORE_CHARGE]);
      expect(testApp.gateway.requests[index]?.reference).toBe(
        [first.body.reference, second.body.reference][index],
      );
    }

    // The two References are fresh and distinct.
    expect(first.body.reference).not.toBe(second.body.reference);
    expect(first.body.reference).toMatch(/^ORD-[0-9A-HJKMNP-TV-Z]{26}$/);
  } finally {
    await testApp.app.close();
  }
}

async function send(testApp: RecordingTransactionsApp, key: string, input: Case) {
  const response = await request(testApp.app.getHttpServer())
    .post(PATH)
    .set('Content-Type', 'application/json')
    .set('Idempotency-Key', key)
    .send(bodyFor(input));
  return { status: response.status, body: response.body as { reference: string } };
}

describe('Property 13: PENDING persistence happens before any Provider call', () => {
  it(
    'writes the Delivery, the Transaction and the attached id strictly before PaymentGateway.create',
    async () => {
      await fc.assert(fc.asyncProperty(caseArbitrary, runCase), { numRuns: NUM_RUNS });
    },
    PROPERTY_TIMEOUT_MS,
  );
});
