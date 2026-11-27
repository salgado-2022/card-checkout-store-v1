import { err, ok } from 'neverthrow';
import request from 'supertest';
import { PAYMENT_PROVIDER_ERROR_BODY } from '../../../application/use-cases/create-transaction';
import { requestHash, type JsonValue } from '../../../application/request-hash';
import { FakeIdGenerator } from '../../../../test/support/fake-id-generator';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import type { PaymentCreateResponse } from '../../../application/ports/payment-gateway';
import type { TransactionStatus } from '../../../domain/transaction-status';
import { envelopeFor } from '../error-catalog';

const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0001';
const CARD_TOKEN = 'tok_test_fake';
const UNIT_PRICE = 12_000_000;
const TOTAL = 2 * UNIT_PRICE + 300_000 + 800_000;

const RESPONSE_FIELDS = ['amounts', 'card', 'createdAt', 'deliveryId', 'id', 'reference', 'status'];

type Body = Record<string, unknown>;

function validBody(): Body {
  return {
    productId: 'prod-1',
    quantity: 2,
    customerId: 'cust-1',
    delivery: {
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 # 2-3',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
    },
    payment: { cardToken: CARD_TOKEN, installments: 3, brand: 'VISA', lastFour: '4242' },
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  };
}

// The use case takes its first ULID as the Reference. A fresh fake generator yields the same one.
function referenceOfFirstAttempt(): string {
  return `ORD-${new FakeIdGenerator().ulid()}`;
}

function providerAnswer(
  status: TransactionStatus,
  overrides: Partial<PaymentCreateResponse> = {},
): PaymentCreateResponse {
  return {
    externalId: 'ext-1',
    status,
    message: null,
    amountInCents: TOTAL,
    currency: 'COP',
    reference: referenceOfFirstAttempt(),
    ...overrides,
  };
}

// `null` sends no Idempotency-Key header at all.
function post(testApp: TransactionsHttpApp, body: unknown, key: string | null = KEY): request.Test {
  const req = request(testApp.app.getHttpServer())
    .post(PATH)
    .set('Content-Type', 'application/json');
  if (key !== null) {
    req.set('Idempotency-Key', key);
  }
  return req.send(body as object);
}

function expectNoWrites(testApp: TransactionsHttpApp, stock = TRANSACTION_PRODUCT.stock): void {
  expect(testApp.transactions.count()).toBe(0);
  expect(testApp.deliveries.count()).toBe(0);
  expect(testApp.gateway.callLog).toEqual([]);
  expect(testApp.idempotency.get(KEY)).toBeUndefined();
  expect(testApp.products.stockOf('prod-1')).toBe(stock);
}

describe('TransactionsController (HTTP)', () => {
  let testApp: TransactionsHttpApp;

  beforeEach(async () => {
    testApp = await createTransactionsHttpApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  describe('POST /api/v1/transactions: success', () => {
    it('returns 201 with exactly the documented fields and never the card token', async () => {
      testApp.gateway.script.create.enqueue(ok(providerAnswer('PENDING')));

      const response = await post(testApp, validBody());

      expect(response.status).toBe(201);
      expect(Object.keys(response.body).sort()).toEqual(RESPONSE_FIELDS);
      expect(response.body).toEqual({
        id: expect.any(String),
        reference: referenceOfFirstAttempt(),
        status: 'PENDING',
        amounts: {
          currency: 'COP',
          subtotalInCents: 2 * UNIT_PRICE,
          baseFeeInCents: 300_000,
          deliveryFeeInCents: 800_000,
          totalInCents: TOTAL,
        },
        deliveryId: expect.any(String),
        card: { brand: 'VISA', lastFour: '4242' },
        createdAt: '2026-05-01T10:00:00.000Z',
      });
      expect(response.text).not.toContain(CARD_TOKEN);
      expect(testApp.gateway.script.create.calls[0]?.[0].cardToken).toBe(CARD_TOKEN);
      expect(testApp.transactions.count()).toBe(1);
      expect(testApp.deliveries.count()).toBe(1);
      expect(testApp.products.stockOf('prod-1')).toBe(TRANSACTION_PRODUCT.stock);
    });

    it('returns 201 with APPROVED and decrements the stock when the provider approves', async () => {
      testApp.gateway.script.create.enqueue(ok(providerAnswer('APPROVED')));

      const response = await post(testApp, validBody());

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('APPROVED');
      expect(testApp.products.stockOf('prod-1')).toBe(TRANSACTION_PRODUCT.stock - 2);
    });

    it('replays the stored response with 200 for the same key and body, without a second charge', async () => {
      testApp.gateway.script.create.enqueue(ok(providerAnswer('PENDING')));

      const first = await post(testApp, validBody());
      const replay = await post(testApp, validBody());

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(testApp.gateway.callCount('create')).toBe(1);
      expect(testApp.transactions.count()).toBe(1);
    });

    it('treats bodies that differ only in key order as the same request', async () => {
      testApp.gateway.script.create.enqueue(ok(providerAnswer('PENDING')));
      const reordered = {
        acceptPersonalAuth: 'auth_test_fake',
        acceptanceToken: 'acc_test_fake',
        payment: validBody().payment,
        delivery: validBody().delivery,
        customerId: 'cust-1',
        quantity: 2,
        productId: 'prod-1',
      };

      await post(testApp, validBody());
      const replay = await post(testApp, reordered);

      expect(replay.status).toBe(200);
      expect(testApp.gateway.callCount('create')).toBe(1);
    });
  });

  describe('POST /api/v1/transactions: idempotency', () => {
    it('returns 422 IDEMPOTENCY_KEY_REUSED when the key comes with a different body', async () => {
      testApp.gateway.script.create.enqueue(ok(providerAnswer('PENDING')));
      await post(testApp, validBody());

      const response = await post(testApp, { ...validBody(), quantity: 3 });

      expect(response.status).toBe(422);
      expect(response.body).toEqual(envelopeFor('IDEMPOTENCY_KEY_REUSED'));
      expect(testApp.gateway.callCount('create')).toBe(1);
    });

    it('returns 409 IDEMPOTENCY_KEY_IN_PROGRESS for a fresh in-progress record with the same body', async () => {
      const seeded = await testApp.idempotency.begin(
        KEY,
        requestHash(JSON.parse(JSON.stringify(validBody())) as JsonValue),
        testApp.clock.now(),
      );
      expect(seeded.isOk()).toBe(true);

      const response = await post(testApp, validBody());

      expect(response.status).toBe(409);
      expect(response.body).toEqual(envelopeFor('IDEMPOTENCY_KEY_IN_PROGRESS'));
      expect(testApp.gateway.callLog).toEqual([]);
      expect(testApp.transactions.count()).toBe(0);
    });

    it('returns 400 MISSING_IDEMPOTENCY_KEY when the header is absent', async () => {
      const response = await post(testApp, validBody(), null);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(envelopeFor('MISSING_IDEMPOTENCY_KEY'));
      expectNoWrites(testApp);
    });

    it('returns 400 VALIDATION_ERROR naming the header when the key breaks its rule', async () => {
      const response = await post(testApp, validBody(), 'short');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toEqual([expect.stringMatching(/^Idempotency-Key: /)]);
      expectNoWrites(testApp);
    });
  });

  describe('POST /api/v1/transactions: validation', () => {
    const cases: [string, (body: Body) => void, string][] = [
      ['productId empty', (b) => (b.productId = ''), 'productId: isLength'],
      ['quantity below 1', (b) => (b.quantity = 0), 'quantity: min'],
      ['quantity above 5', (b) => (b.quantity = 6), 'quantity: max'],
      ['quantity not an integer', (b) => (b.quantity = 1.5), 'quantity: isInt'],
      ['quantity as a string', (b) => (b.quantity = '2'), 'quantity: isInt'],
      ['customerId missing', (b) => delete b.customerId, 'customerId: isString'],
      ['delivery missing', (b) => delete b.delivery, 'delivery: isObject'],
      ['payment missing', (b) => delete b.payment, 'payment: isObject'],
      [
        'recipientName too short',
        (b) => (delivery(b).recipientName = 'AB'),
        'delivery.recipientName: isLength',
      ],
      [
        'phone not starting with 3',
        (b) => (delivery(b).phone = '2001234567'),
        'delivery.phone: matches',
      ],
      [
        'addressLine1 too short',
        (b) => (delivery(b).addressLine1 = 'abc'),
        'delivery.addressLine1: isLength',
      ],
      [
        'addressLine2 longer than 60',
        (b) => (delivery(b).addressLine2 = 'A'.repeat(61)),
        'delivery.addressLine2: maxLength',
      ],
      [
        'addressLine2 sent as null',
        (b) => (delivery(b).addressLine2 = null),
        'delivery.addressLine2: isString',
      ],
      ['city too short', (b) => (delivery(b).city = 'A'), 'delivery.city: isLength'],
      [
        'department not in the closed list',
        (b) => (delivery(b).department = 'Narnia'),
        'delivery.department: isIn',
      ],
      [
        'postalCode not 6 digits',
        (b) => (delivery(b).postalCode = '12345'),
        'delivery.postalCode: matches',
      ],
      ['installments below 1', (b) => (payment(b).installments = 0), 'payment.installments: min'],
      ['installments above 36', (b) => (payment(b).installments = 37), 'payment.installments: max'],
      ['brand not allowed', (b) => (payment(b).brand = 'AMEX'), 'payment.brand: isIn'],
      ['lastFour not 4 digits', (b) => (payment(b).lastFour = '42a4'), 'payment.lastFour: matches'],
      ['cardToken empty', (b) => (payment(b).cardToken = ''), 'payment.cardToken: isLength'],
      [
        'cardToken that looks like a card number',
        (b) => (payment(b).cardToken = '4242424242424242'),
        'payment.cardToken: matches',
      ],
      [
        'cardToken with characters outside the token charset',
        (b) => (payment(b).cardToken = 'tok test fake'),
        'payment.cardToken: matches',
      ],
      ['acceptanceToken empty', (b) => (b.acceptanceToken = ''), 'acceptanceToken: isLength'],
      [
        'acceptPersonalAuth missing',
        (b) => delete b.acceptPersonalAuth,
        'acceptPersonalAuth: isString',
      ],
      [
        'amount property at the root',
        (b) => (b.totalInCents = 1),
        'totalInCents: whitelistValidation',
      ],
      [
        'undeclared property in delivery',
        (b) => (delivery(b).amountInCents = 1),
        'delivery.amountInCents: whitelistValidation',
      ],
    ];

    it.each(cases)('returns 400 VALIDATION_ERROR when %s', async (_label, mutate, expected) => {
      const body = validBody();
      mutate(body);

      const response = await post(testApp, body);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toContain(expected);
      expectNoWrites(testApp);
    });
  });

  describe('POST /api/v1/transactions: business errors', () => {
    it('returns 404 PRODUCT_NOT_FOUND for an unknown product', async () => {
      const response = await post(testApp, { ...validBody(), productId: 'missing' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual(envelopeFor('PRODUCT_NOT_FOUND'));
      expectNoWrites(testApp);
    });

    it('returns 404 CUSTOMER_NOT_FOUND for an unknown customer', async () => {
      const response = await post(testApp, { ...validBody(), customerId: 'missing' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual(envelopeFor('CUSTOMER_NOT_FOUND'));
      expectNoWrites(testApp);
    });

    it('returns 409 INSUFFICIENT_STOCK with the available units in details only', async () => {
      await testApp.app.close();
      testApp = await createTransactionsHttpApp({
        products: [{ ...TRANSACTION_PRODUCT, stock: 1 }],
      });

      const response = await post(testApp, validBody());

      expect(response.status).toBe(409);
      expect(response.body).toEqual(envelopeFor('INSUFFICIENT_STOCK', ['quantity: available=1']));
      expect(response.body.message).toBe('Not enough stock for the requested quantity.');
      expectNoWrites(testApp, 1);
    });

    it('returns 502 with the catalog PAYMENT_PROVIDER_ERROR envelope when the provider rejects', async () => {
      testApp.gateway.script.create.enqueue(
        err({ kind: 'REJECTED', providerMessage: 'rejected', afterTransientFailure: false }),
      );

      const response = await post(testApp, validBody());

      expect(response.status).toBe(502);
      expect(response.body).toEqual(PAYMENT_PROVIDER_ERROR_BODY);
      expect(response.body).toEqual(envelopeFor('PAYMENT_PROVIDER_ERROR'));
      expect(testApp.products.stockOf('prod-1')).toBe(TRANSACTION_PRODUCT.stock);
      expect(testApp.transactions.count()).toBe(1);
      expect(response.text).not.toContain(CARD_TOKEN);
    });
  });
});

function delivery(body: Body): Body {
  return body.delivery as Body;
}

function payment(body: Body): Body {
  return body.payment as Body;
}
