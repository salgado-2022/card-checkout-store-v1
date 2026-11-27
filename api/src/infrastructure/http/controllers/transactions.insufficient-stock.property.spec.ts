import * as fc from 'fast-check';
import request from 'supertest';
import {
  createRecordingTransactionsApp,
  type RecordingTransactionsApp,
} from '../../../../test/support/recording-transactions-app';
import {
  TRANSACTION_CUSTOMER,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';
import type { Product } from '../../../domain/entities';

// Feature: payments-api, Property 10: Insufficient stock blocks transaction creation without side effects
// Validates: Requirements 5.8

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0010';
const CUSTOMER_ID = TRANSACTION_CUSTOMER.id;

interface StockCase {
  readonly stock: number;
  readonly quantity: number;
}

// stock < quantity, with quantity inside the 1..5 rule of the request.
const stockCaseArbitrary: fc.Arbitrary<StockCase> = fc.integer({ min: 0, max: 4 }).chain((stock) =>
  fc.record({
    stock: fc.constant(stock),
    quantity: fc.integer({ min: stock + 1, max: 5 }),
  }),
);

function bodyFor(quantity: number) {
  return {
    productId: TRANSACTION_PRODUCT.id,
    quantity,
    customerId: CUSTOMER_ID,
    delivery: {
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 # 2-3',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
    },
    payment: { cardToken: 'tok_test_fake', installments: 1, brand: 'VISA', lastFour: '4242' },
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  };
}

function productWithStock(stock: number): Product {
  return { ...TRANSACTION_PRODUCT, stock };
}

async function runCase(stockCase: StockCase): Promise<void> {
  const testApp: RecordingTransactionsApp = await createRecordingTransactionsApp({
    products: [productWithStock(stockCase.stock)],
  });
  try {
    const response = await request(testApp.app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', KEY)
      .send(bodyFor(stockCase.quantity));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK',
      message: expect.any(String),
      details: [`quantity: available=${stockCase.stock}`],
    });
    expect(response.text).not.toContain('tok_test_fake');

    // No Transaction, no Delivery, no provider call, and the idempotency record is released.
    expect(testApp.transactions.count()).toBe(0);
    expect(testApp.deliveries.count()).toBe(0);
    expect(testApp.gateway.requests).toEqual([]);
    expect(testApp.idempotency.get(KEY)).toBeUndefined();
    expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(stockCase.stock);
    expect(testApp.steps.names()).toEqual(['idempotency.begin', 'idempotency.release']);
  } finally {
    await testApp.app.close();
  }
}

describe('Property 10: Insufficient stock blocks transaction creation without side effects', () => {
  it(
    'answers 409 INSUFFICIENT_STOCK with the available units and writes nothing when stock < quantity',
    async () => {
      await fc.assert(fc.asyncProperty(stockCaseArbitrary, runCase), { numRuns: NUM_RUNS });
    },
    PROPERTY_TIMEOUT_MS,
  );
});
