import { ok } from 'neverthrow';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { FakeIdGenerator } from '../../../../test/support/fake-id-generator';
import { createDeliveriesHttpApp } from '../../../../test/support/deliveries-http-app';
import { InMemoryDeliveryRepository } from '../../../../test/support/in-memory-delivery-repository';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import type { NewDelivery } from '../../../application/ports/delivery-repository';
import { envelopeFor } from '../error-catalog';

const PATH = '/api/v1/deliveries';
const REQUIRED_FIELDS = [
  'addressLine1',
  'city',
  'createdAt',
  'department',
  'id',
  'phone',
  'productId',
  'quantity',
  'recipientName',
  'status',
  'transactionId',
  'updatedAt',
];
const DELIVERY_ID = '01HZX0000000000000000000JN';
const TRANSACTION_ID = '01HZX0000000000000000000EF';

const FULL_DELIVERY: NewDelivery = {
  id: DELIVERY_ID,
  transactionId: TRANSACTION_ID,
  productId: 'prod-1',
  quantity: 2,
  recipientName: 'Ana Perez',
  phone: '3001234567',
  addressLine1: 'Calle 1 # 2-3',
  addressLine2: 'Apto 401',
  city: 'Bogotá',
  department: 'Bogotá D.C.',
  postalCode: '110111',
  createdAt: '2026-05-01T10:00:00.000Z',
};

const MINIMAL_DELIVERY: NewDelivery = {
  ...FULL_DELIVERY,
  id: '01HZX0000000000000000000KM',
  addressLine2: undefined,
  postalCode: undefined,
};

function expectKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  expect(Object.keys(body).sort()).toEqual([...expected].sort());
}

describe('GET /deliveries/:id (HTTP)', () => {
  let deliveries: InMemoryDeliveryRepository;
  let app: INestApplication;

  beforeEach(async () => {
    deliveries = new InMemoryDeliveryRepository();
    app = await createDeliveriesHttpApp({ deliveries });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers every field, including the optional ones when they are stored', async () => {
    await deliveries.create(FULL_DELIVERY);

    const response = await request(app.getHttpServer()).get(`${PATH}/${DELIVERY_ID}`).expect(200);

    const body = response.body as Record<string, unknown>;
    expectKeys(body, [...REQUIRED_FIELDS, 'addressLine2', 'postalCode']);
    expect(body).toEqual({
      id: DELIVERY_ID,
      transactionId: TRANSACTION_ID,
      productId: 'prod-1',
      quantity: 2,
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 # 2-3',
      addressLine2: 'Apto 401',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
      postalCode: '110111',
      status: 'PENDING',
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    });
  });

  it('omits the optional fields when they were not stored', async () => {
    await deliveries.create(MINIMAL_DELIVERY);

    const response = await request(app.getHttpServer())
      .get(`${PATH}/${MINIMAL_DELIVERY.id}`)
      .expect(200);

    expectKeys(response.body as Record<string, unknown>, REQUIRED_FIELDS);
  });

  it('answers the status of a Delivery that was updated', async () => {
    await deliveries.create(MINIMAL_DELIVERY);
    deliveries.updateStatus(MINIMAL_DELIVERY.id, 'ASSIGNED', '2026-05-01T10:00:05.000Z');

    const response = await request(app.getHttpServer())
      .get(`${PATH}/${MINIMAL_DELIVERY.id}`)
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ASSIGNED',
      updatedAt: '2026-05-01T10:00:05.000Z',
    });
  });

  it('answers 404 DELIVERY_NOT_FOUND for a well-formed id that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/01HZX0000000000000000000ZZ`)
      .expect(404);

    expect(response.body).toEqual(envelopeFor('DELIVERY_NOT_FOUND'));
  });

  it.each([
    ['text that is not an id', 'not-a-ulid'],
    ['a lowercase ULID', '01hzx0000000000000000000ij'],
    ['a ULID one character short', '01HZX0000000000000000000I'],
    ['a first character above 7', '81HZX0000000000000000000JN'],
    ['unicode letters', 'ñandú-ñandú-ñandú-ñandú-ñ'],
    ['an encoded null byte', '%00'],
    ['a very long value', 'a'.repeat(5000)],
  ])('answers 404 DELIVERY_NOT_FOUND for %s', async (_label, id) => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${encodeURIComponent(id)}`)
      .expect(404);

    expect(response.body).toEqual(envelopeFor('DELIVERY_NOT_FOUND'));
  });
});

describe('Delivery created by POST /transactions', () => {
  let transactions: TransactionsHttpApp;
  let deliveriesApp: INestApplication;

  beforeEach(async () => {
    transactions = await createTransactionsHttpApp();
    deliveriesApp = await createDeliveriesHttpApp({ deliveries: transactions.deliveries });
  });

  afterEach(async () => {
    await transactions.app.close();
    await deliveriesApp.close();
  });

  it('carries the transactionId of its Transaction and is readable through GET /deliveries/:id', async () => {
    const reference = `ORD-${new FakeIdGenerator().ulid()}`;
    transactions.gateway.script.create.enqueue(
      ok({
        externalId: 'ext-1',
        status: 'PENDING',
        message: null,
        amountInCents: 2 * TRANSACTION_PRODUCT.priceInCents + 300_000 + 800_000,
        currency: 'COP',
        reference,
      }),
    );
    const created = await request(transactions.app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'idem-key-0002')
      .send({
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
        payment: { cardToken: 'tok_test_fake', installments: 1, brand: 'VISA', lastFour: '4242' },
        acceptanceToken: 'acc_test_fake',
        acceptPersonalAuth: 'auth_test_fake',
      })
      .expect(201);
    const { id, deliveryId } = created.body as { id: string; deliveryId: string };

    const response = await request(deliveriesApp.getHttpServer())
      .get(`${PATH}/${deliveryId}`)
      .expect(200);

    expect(response.body).toMatchObject({ id: deliveryId, transactionId: id, status: 'PENDING' });
  });
});
