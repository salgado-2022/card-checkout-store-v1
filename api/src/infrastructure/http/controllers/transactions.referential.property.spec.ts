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

// Feature: payments-api, Property 11: Referential validation gates transaction creation
// Validates: Requirements 5.6, 5.7

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0011';

type MissingReference = 'product' | 'customer';

// Ids that the fakes never store. They keep the DTO rule (1..64 characters) and differ from the seeds.
const unknownIdArbitrary: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9]{1,64}$/)
  .filter((id) => id !== TRANSACTION_PRODUCT.id && id !== TRANSACTION_CUSTOMER.id);

const caseArbitrary = fc.record({
  missing: fc.constantFrom<MissingReference>('product', 'customer'),
  unknownId: unknownIdArbitrary,
  quantity: fc.integer({ min: 1, max: 5 }),
});

function bodyFor(productId: string, customerId: string, quantity: number) {
  return {
    productId,
    quantity,
    customerId,
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

async function runCase(input: {
  missing: MissingReference;
  unknownId: string;
  quantity: number;
}): Promise<void> {
  const testApp: RecordingTransactionsApp = await createRecordingTransactionsApp();
  try {
    const productId = input.missing === 'product' ? input.unknownId : TRANSACTION_PRODUCT.id;
    const customerId = input.missing === 'customer' ? input.unknownId : TRANSACTION_CUSTOMER.id;
    const response = await request(testApp.app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', KEY)
      .send(bodyFor(productId, customerId, input.quantity));

    const expectedCode = input.missing === 'product' ? 'PRODUCT_NOT_FOUND' : 'CUSTOMER_NOT_FOUND';
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: expectedCode,
      message: expect.any(String),
      details: [],
    });

    // Rejected before any amount is computed: no write, no provider call, no idempotency record.
    expect(testApp.transactions.count()).toBe(0);
    expect(testApp.deliveries.count()).toBe(0);
    expect(testApp.gateway.requests).toEqual([]);
    expect(testApp.idempotency.get(KEY)).toBeUndefined();
    expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(TRANSACTION_PRODUCT.stock);
    expect(testApp.steps.names().filter((name) => name.startsWith('transaction.'))).toEqual([]);
    expect(testApp.steps.names().filter((name) => name.startsWith('delivery.'))).toEqual([]);
  } finally {
    await testApp.app.close();
  }
}

describe('Property 11: Referential validation gates transaction creation', () => {
  it(
    'answers 404 PRODUCT_NOT_FOUND or CUSTOMER_NOT_FOUND before any write or provider call',
    async () => {
      await fc.assert(fc.asyncProperty(caseArbitrary, runCase), { numRuns: NUM_RUNS });
    },
    PROPERTY_TIMEOUT_MS,
  );
});
