import request from 'supertest';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import { envelopeFor } from '../error-catalog';

const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0001';

// Object.prototype names that a client could send. JSON.parse keeps them as own properties, and
// class-transformer would drop or inherit them, so each must be rejected before transformation.
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const VALID_DELIVERY = {
  recipientName: 'Ana Perez',
  phone: '3001234567',
  addressLine1: 'Calle 1 # 2-3',
  city: 'Bogotá',
  department: 'Bogotá D.C.',
};

const VALID_PAYMENT = {
  cardToken: 'tok_test_fake',
  installments: 3,
  brand: 'VISA',
  lastFour: '4242',
};

// Serialized by hand: an object literal with a `__proto__` key would set the prototype instead.
function validJson(): string {
  return JSON.stringify({
    productId: 'prod-1',
    quantity: 2,
    customerId: 'cust-1',
    delivery: VALID_DELIVERY,
    payment: VALID_PAYMENT,
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  });
}

// Appends `"key":"x"` as the last member of the JSON object `json`.
function withExtraKey(json: string, key: string): string {
  return `${json.slice(0, -1)},${JSON.stringify(key)}:"x"}`;
}

// Replaces one serialized nested object inside the root JSON with a copy that has an extra key.
function withExtraNestedKey(root: string, nested: object, key: string): string {
  const original = JSON.stringify(nested);
  return root.replace(original, () => withExtraKey(original, key));
}

async function postRaw(testApp: TransactionsHttpApp, rawBody: string) {
  return request(testApp.app.getHttpServer())
    .post(PATH)
    .set('Idempotency-Key', KEY)
    .set('Content-Type', 'application/json')
    .send(rawBody);
}

function expectRejectedWithoutWrites(
  testApp: TransactionsHttpApp,
  response: request.Response,
  detail: string,
): void {
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ ...envelopeFor('VALIDATION_ERROR', [detail]) });
  expect(testApp.transactions.count()).toBe(0);
  expect(testApp.deliveries.count()).toBe(0);
  expect(testApp.gateway.callLog).toEqual([]);
  expect(testApp.idempotency.get(KEY)).toBeUndefined();
}

describe('POST /api/v1/transactions: Object.prototype keys in the raw body', () => {
  let testApp: TransactionsHttpApp;

  beforeEach(async () => {
    testApp = await createTransactionsHttpApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  it.each(PROTOTYPE_KEYS)(
    'rejects a root key named %s with 400 VALIDATION_ERROR and no write',
    async (key) => {
      const response = await postRaw(testApp, withExtraKey(validJson(), key));

      expectRejectedWithoutWrites(testApp, response, `${key}: whitelistValidation`);
    },
  );

  it.each(PROTOTYPE_KEYS)(
    'rejects a key named %s inside delivery with 400 and no write',
    async (key) => {
      const raw = withExtraNestedKey(validJson(), VALID_DELIVERY, key);

      const response = await postRaw(testApp, raw);

      expectRejectedWithoutWrites(testApp, response, `delivery.${key}: whitelistValidation`);
    },
  );

  it.each(PROTOTYPE_KEYS)(
    'rejects a key named %s inside payment with 400 and no write',
    async (key) => {
      const raw = withExtraNestedKey(validJson(), VALID_PAYMENT, key);

      const response = await postRaw(testApp, raw);

      expectRejectedWithoutWrites(testApp, response, `payment.${key}: whitelistValidation`);
    },
  );

  it('never returns the card token in a rejected body', async () => {
    const raw = withExtraNestedKey(validJson(), VALID_PAYMENT, '__proto__');

    const response = await postRaw(testApp, raw);

    expect(response.text).not.toContain('tok_test_fake');
  });
});
