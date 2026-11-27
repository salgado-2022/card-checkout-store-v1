import { err, ok } from 'neverthrow';
import request from 'supertest';
import { FakeIdGenerator } from '../../../../test/support/fake-id-generator';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import type {
  PaymentCreateResponse,
  ProviderStatusReport,
} from '../../../application/ports/payment-gateway';
import type { TransactionStatus } from '../../../domain/transaction-status';
import { envelopeFor } from '../error-catalog';

const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0001';
const CARD_TOKEN = 'tok_test_fake';
const EXTERNAL_ID = 'ext-1';
const TOTAL = 2 * TRANSACTION_PRODUCT.priceInCents + 300_000 + 800_000;
const CREATE_FIELDS = ['amounts', 'card', 'createdAt', 'deliveryId', 'id', 'reference', 'status'];
const DETAIL_FIELDS = [
  'amounts',
  'card',
  'createdAt',
  'deliveryId',
  'id',
  'installments',
  'productId',
  'quantity',
  'reference',
  'status',
  'updatedAt',
];

type Json = Record<string, unknown>;

function validBody(): Json {
  return {
    productId: TRANSACTION_PRODUCT.id,
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

// The first Reference the use case generates with a fresh fake id generator.
function firstReference(): string {
  return `ORD-${new FakeIdGenerator().ulid()}`;
}

function providerAnswer(
  status: TransactionStatus,
  overrides: Partial<PaymentCreateResponse> = {},
): PaymentCreateResponse {
  return {
    externalId: EXTERNAL_ID,
    status,
    message: null,
    amountInCents: TOTAL,
    currency: 'COP',
    reference: firstReference(),
    ...overrides,
  };
}

function statusReport(status: TransactionStatus): ProviderStatusReport {
  const answer = providerAnswer(status);
  return {
    status: answer.status,
    message: answer.message,
    amountInCents: answer.amountInCents,
    currency: answer.currency,
    reference: answer.reference,
  };
}

async function createThrough(testApp: TransactionsHttpApp, reply: PaymentCreateResponse | null) {
  if (reply === null) {
    testApp.gateway.script.create.enqueue(err({ kind: 'UNAVAILABLE', reason: 'timeout' }));
  } else {
    testApp.gateway.script.create.enqueue(ok(reply));
  }
  const response = await request(testApp.app.getHttpServer())
    .post(PATH)
    .set('Content-Type', 'application/json')
    .set('Idempotency-Key', KEY)
    .send(validBody())
    .expect(201);
  return response.body as Json & { id: string };
}

function get(testApp: TransactionsHttpApp, id: string): request.Test {
  return request(testApp.app.getHttpServer()).get(`${PATH}/${encodeURIComponent(id)}`);
}

function expectKeys(body: Json, expected: readonly string[]): void {
  expect(Object.keys(body).sort()).toEqual([...expected].sort());
}

describe('GET /transactions/:id (HTTP)', () => {
  let testApp: TransactionsHttpApp;

  beforeEach(async () => {
    testApp = await createTransactionsHttpApp();
  });

  afterEach(async () => {
    await testApp.app.close();
  });

  it('keeps the create response shape exactly', async () => {
    const created = await createThrough(testApp, providerAnswer('PENDING'));

    expectKeys(created, CREATE_FIELDS);
  });

  it('answers the full shape of an approved Transaction without a status reason', async () => {
    const created = await createThrough(testApp, providerAnswer('APPROVED'));

    const response = await get(testApp, created.id).expect(200);

    const body = response.body as Json;
    expectKeys(body, [...DETAIL_FIELDS, 'finalizedAt']);
    expect(body).toEqual({
      id: created.id,
      reference: created.reference,
      status: 'APPROVED',
      amounts: {
        currency: 'COP',
        subtotalInCents: 2 * TRANSACTION_PRODUCT.priceInCents,
        baseFeeInCents: 300_000,
        deliveryFeeInCents: 800_000,
        totalInCents: TOTAL,
      },
      deliveryId: created.deliveryId,
      card: { brand: 'VISA', lastFour: '4242' },
      productId: TRANSACTION_PRODUCT.id,
      quantity: 2,
      installments: 3,
      createdAt: created.createdAt,
      updatedAt: body.updatedAt,
      finalizedAt: body.finalizedAt,
    });
    expect(body.finalizedAt).toEqual(expect.any(String));
  });

  it('includes the status reason of a declined Transaction', async () => {
    const created = await createThrough(
      testApp,
      providerAnswer('DECLINED', { message: 'Fondos insuficientes' }),
    );

    const response = await get(testApp, created.id).expect(200);

    expectKeys(response.body as Json, [...DETAIL_FIELDS, 'finalizedAt', 'statusReason']);
    expect(response.body).toMatchObject({
      status: 'DECLINED',
      statusReason: 'Fondos insuficientes',
    });
  });

  it('does not call the provider for a Transaction that is already final', async () => {
    const created = await createThrough(testApp, providerAnswer('APPROVED'));

    await get(testApp, created.id).expect(200);

    expect(testApp.gateway.callCount('getStatus')).toBe(0);
    expect(testApp.gateway.callCount('findByReference')).toBe(0);
  });

  it('never exposes the External_Id, the last sync time or the card token', async () => {
    const created = await createThrough(testApp, providerAnswer('PENDING'));
    testApp.gateway.script.getStatus.enqueue(ok(statusReport('PENDING')));

    const response = await get(testApp, created.id).expect(200);

    const body = response.body as Json;
    expectKeys(body, DETAIL_FIELDS);
    expect(body).not.toHaveProperty('externalId');
    expect(body).not.toHaveProperty('lastSyncedAt');
    expect(JSON.stringify(body)).not.toContain(EXTERNAL_ID);
    expect(JSON.stringify(body)).not.toContain(CARD_TOKEN);

    const stored = testApp.transactions.get(created.id);
    expect(stored?.externalId).toBe(EXTERNAL_ID);
    expect(stored?.lastSyncedAt).toBeDefined();
  });

  it('keeps a Transaction without External_Id PENDING when the lookup finds nothing', async () => {
    const created = await createThrough(testApp, null);
    testApp.gateway.script.findByReference.enqueue(ok({ kind: 'not_found' }));

    const response = await get(testApp, created.id).expect(200);

    expectKeys(response.body as Json, DETAIL_FIELDS);
    expect(response.body).toMatchObject({ id: created.id, status: 'PENDING' });
    expect(testApp.gateway.callCount('create')).toBe(1);
    expect(testApp.gateway.callCount('findByReference')).toBe(1);
  });

  it('answers 404 TRANSACTION_NOT_FOUND for a well-formed id that does not exist', async () => {
    const response = await get(testApp, '01HZX0000000000000000000ZZ').expect(404);

    expect(response.body).toEqual(envelopeFor('TRANSACTION_NOT_FOUND'));
    expect(testApp.gateway.callLog).toEqual([]);
  });

  it.each([
    ['text that is not an id', 'not-a-ulid'],
    ['a lowercase ULID', '01hzx0000000000000000000ef'],
    ['a ULID one character short', '01HZX0000000000000000000E'],
    ['a ULID one character long', '01HZX0000000000000000000EFA'],
    ['a first character above 7', '81HZX0000000000000000000EF'],
    ['a letter excluded from Crockford base32', '01HZX000000000000000000IEF'],
    ['a reference instead of an id', 'ORD-01HZX0000000000000000000EF'],
    ['unicode letters', 'ñandú-ñandú-ñandú-ñandú-ñ'],
    ['an emoji', '🧾🧾🧾🧾'],
    ['an encoded null byte', '\u0000'],
    ['an encoded slash', '01HZX0000000000000000000EF/extra'],
    ['a very long value', 'a'.repeat(5000)],
  ])('answers 404 TRANSACTION_NOT_FOUND for %s', async (_label, id) => {
    const response = await get(testApp, id).expect(404);

    expect(response.body).toEqual(envelopeFor('TRANSACTION_NOT_FOUND'));
    expect(testApp.gateway.callLog).toEqual([]);
  });
});
