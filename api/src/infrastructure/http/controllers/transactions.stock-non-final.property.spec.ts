import { err, ok, type Result } from 'neverthrow';
import * as fc from 'fast-check';
import request from 'supertest';
import type { PaymentGatewayError } from '../../../application/errors';
import type { PaymentCreateResponse } from '../../../application/ports/payment-gateway';
import {
  createRecordingTransactionsApp,
  type GatewayReply,
  type RecordingTransactionsApp,
} from '../../../../test/support/recording-transactions-app';
import {
  TRANSACTION_CUSTOMER,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';
import type { Product } from '../../../domain/entities';

// Feature: payments-api, Property 15: Stock is unchanged for any non-final transaction
// Validates: Requirements 5.15

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0015';

type NonFinalOutcome = 'PENDING' | 'UNAVAILABLE' | 'REJECTED_AFTER_TRANSIENT';

const caseArbitrary = fc.record({
  outcome: fc.constantFrom<NonFinalOutcome>('PENDING', 'UNAVAILABLE', 'REJECTED_AFTER_TRANSIENT'),
  stock: fc.integer({ min: 5, max: 50 }),
  quantity: fc.integer({ min: 1, max: 5 }),
  installments: fc.integer({ min: 1, max: 36 }),
});

interface Case {
  readonly outcome: NonFinalOutcome;
  readonly stock: number;
  readonly quantity: number;
  readonly installments: number;
}

function replyFor(outcome: NonFinalOutcome): GatewayReply {
  return (request): Result<PaymentCreateResponse, PaymentGatewayError> => {
    if (outcome === 'PENDING') {
      return ok({
        externalId: 'ext-15',
        status: 'PENDING',
        message: null,
        amountInCents: request.amountInCents,
        currency: request.currency,
        reference: request.reference,
      });
    }
    if (outcome === 'UNAVAILABLE') {
      return err({ kind: 'UNAVAILABLE', reason: 'timeout' });
    }
    return err({
      kind: 'REJECTED',
      providerMessage: 'Declined by the provider.',
      afterTransientFailure: true,
    });
  };
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
      cardToken: 'tok_test_fake',
      installments: input.installments,
      brand: 'VISA',
      lastFour: '4242',
    },
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  };
}

async function runCase(input: Case): Promise<void> {
  const product: Product = { ...TRANSACTION_PRODUCT, stock: input.stock };
  const testApp: RecordingTransactionsApp = await createRecordingTransactionsApp({
    products: [product],
    reply: replyFor(input.outcome),
  });
  try {
    const stockBefore = testApp.products.stockOf(product.id);
    const response = await request(testApp.app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', KEY)
      .send(bodyFor(input));

    // Each of these outcomes answers 201 PENDING, with the Transaction and the Delivery still PENDING.
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING');
    const stored = testApp.transactions.get(response.body.id);
    expect(stored?.status).toBe('PENDING');
    // A provider PENDING stores its External_Id; a failed create leaves it unset.
    if (input.outcome === 'PENDING') {
      expect(stored?.externalId).toBe('ext-15');
    } else {
      expect(stored?.externalId).toBeUndefined();
    }
    expect(testApp.deliveries.get(response.body.deliveryId)?.status).toBe('PENDING');

    // Stock is identical before and after, and nothing finalized the Transaction.
    expect(testApp.products.stockOf(product.id)).toBe(stockBefore);
    expect(testApp.steps.names()).not.toContain('transaction.finalize');
  } finally {
    await testApp.app.close();
  }
}

describe('Property 15: Stock is unchanged for any non-final transaction', () => {
  it(
    'keeps the Product stock identical when the create ends PENDING, unreachable or 4xx after a transient failure',
    async () => {
      await fc.assert(fc.asyncProperty(caseArbitrary, runCase), { numRuns: NUM_RUNS });
    },
    PROPERTY_TIMEOUT_MS,
  );
});
