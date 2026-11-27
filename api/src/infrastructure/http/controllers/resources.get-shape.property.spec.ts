import * as fc from 'fast-check';
import request from 'supertest';
import { ok } from 'neverthrow';
import type { Customer, Product } from '../../../domain/entities';
import type { NewDelivery } from '../../../application/ports/delivery-repository';
import { createCatalogHttpApp } from '../../../../test/support/catalog-http-app';
import { createCustomersHttpApp } from '../../../../test/support/customers-http-app';
import { createDeliveriesHttpApp } from '../../../../test/support/deliveries-http-app';
import { InMemoryCustomerRepository } from '../../../../test/support/in-memory-customer-repository';
import { InMemoryDeliveryRepository } from '../../../../test/support/in-memory-delivery-repository';
import { InMemoryProductRepository } from '../../../../test/support/in-memory-product-repository';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  FIXED_KEY,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  providerStatusArbitrary,
  transactionBodyArbitrary,
  type TransactionBody,
} from '../../../../test/support/transaction-property-helpers';
import type { TransactionStatus } from '../../../domain/transaction-status';

// Feature: payments-api, Property 2: Fetching an existing resource returns it with its documented shape

const ISO_DATE = '2026-05-01T10:00:00.000Z';
const PRODUCT_FIELDS = [
  'currency',
  'description',
  'id',
  'imageUrl',
  'name',
  'priceInCents',
  'sku',
  'stock',
];
const CUSTOMER_FIELDS = [
  'createdAt',
  'documentNumber',
  'documentType',
  'email',
  'fullName',
  'id',
  'phone',
  'updatedAt',
];
const TRANSACTION_FIELDS = [
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
const DELIVERY_FIELDS = [
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

// ULID shape the controllers accept: 26 Crockford base32 characters, first one in 0-7.
const ulidArbitrary = fc.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

const productArbitrary: fc.Arbitrary<Product> = fc.record({
  id: ulidArbitrary,
  sku: fc.string({ minLength: 1, maxLength: 20 }),
  name: fc.string({ minLength: 1, maxLength: 40 }),
  description: fc.string({ maxLength: 80 }),
  imageUrl: fc.string({ minLength: 1, maxLength: 40 }),
  priceInCents: fc.integer({ min: 0, max: 1_000_000_000_000 }),
  currency: fc.constant('COP'),
  stock: fc.integer({ min: 0, max: 20 }),
});

const customerArbitrary: fc.Arbitrary<Customer> = fc.record({
  id: ulidArbitrary,
  email: fc.emailAddress(),
  fullName: fc.string({ minLength: 3, maxLength: 40 }),
  phone: fc.stringMatching(/^3[0-9]{9}$/),
  documentType: fc.constantFrom('CC', 'CE', 'NIT', 'PP'),
  documentNumber: fc.stringMatching(/^[0-9]{6,10}$/),
  createdAt: fc.constant(ISO_DATE),
  updatedAt: fc.constant(ISO_DATE),
});

// Optional fields are sometimes absent, so the response must include them only when stored.
const deliveryArbitrary: fc.Arbitrary<NewDelivery> = fc.record({
  id: ulidArbitrary,
  transactionId: ulidArbitrary,
  productId: fc.constant('prod-1'),
  quantity: fc.integer({ min: 1, max: 5 }),
  recipientName: fc.stringMatching(/^[A-Za-z]{3,20}$/),
  phone: fc.stringMatching(/^3[0-9]{9}$/),
  addressLine1: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{4,30}$/),
  addressLine2: fc.option(fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/), { nil: undefined }),
  city: fc.constantFrom('Bogotá', 'Medellín'),
  department: fc.constantFrom('Bogotá D.C.', 'Antioquia'),
  postalCode: fc.option(fc.stringMatching(/^[0-9]{6}$/), { nil: undefined }),
  createdAt: fc.constant(ISO_DATE),
});

const sorted = (fields: readonly string[]): string[] => [...fields].sort();
const keysOf = (body: unknown): string[] => Object.keys(body as object).sort();

async function expectProduct(product: Product): Promise<void> {
  const app = await createCatalogHttpApp({
    products: new InMemoryProductRepository([product]),
    fees: { baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 },
  });
  try {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/products/${product.id}`)
      .expect(200);
    expect(keysOf(response.body)).toEqual(sorted(PRODUCT_FIELDS));
    expect(response.body).toEqual(product);
  } finally {
    await app.close();
  }
}

async function expectCustomer(customer: Customer): Promise<void> {
  const app = await createCustomersHttpApp({
    customers: new InMemoryCustomerRepository([customer]),
  });
  try {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.id}`)
      .expect(200);
    expect(keysOf(response.body)).toEqual(sorted(CUSTOMER_FIELDS));
    expect(response.body).toEqual(customer);
  } finally {
    await app.close();
  }
}

async function expectDelivery(input: NewDelivery): Promise<void> {
  const deliveries = new InMemoryDeliveryRepository();
  const seeded = await deliveries.create(input);
  if (seeded.isErr()) {
    throw new Error('test setup: the delivery could not be seeded');
  }
  const app = await createDeliveriesHttpApp({ deliveries });
  try {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/deliveries/${input.id}`)
      .expect(200);
    const optional = [
      ...(input.addressLine2 === undefined ? [] : ['addressLine2']),
      ...(input.postalCode === undefined ? [] : ['postalCode']),
    ];
    expect(keysOf(response.body)).toEqual(sorted([...DELIVERY_FIELDS, ...optional]));
    expect(response.body).toMatchObject({ id: input.id, status: 'PENDING' });
  } finally {
    await app.close();
  }
}

async function expectTransaction(
  body: TransactionBody,
  reportedStatus: TransactionStatus,
): Promise<void> {
  const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
  try {
    testApp.gateway.script.create.always(ok(providerAnswer(reportedStatus, body.quantity)));
    const created = await postTransaction(testApp, body, FIXED_KEY);
    const id = created.body.id as string;
    const stored = testApp.transactions.get(id);
    expect(stored).toBeDefined();

    const response = await request(testApp.app.getHttpServer())
      .get(`/api/v1/transactions/${id}`)
      .expect(200);
    const payload = response.body as Record<string, unknown>;
    const optional = [
      ...(stored?.statusReason === undefined ? [] : ['statusReason']),
      ...(stored?.finalizedAt === undefined ? [] : ['finalizedAt']),
    ];
    expect(keysOf(payload)).toEqual(sorted([...TRANSACTION_FIELDS, ...optional]));
    expect(payload.status).toBe(stored?.status);
    expect(payload.card).toEqual({ brand: body.payment.brand, lastFour: body.payment.lastFour });
    expect(payload).not.toHaveProperty('externalId');
    expect(payload).not.toHaveProperty('lastSyncedAt');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(body.payment.cardToken);
    expect(serialized).not.toContain('externalId');
  } finally {
    await testApp.app.close();
  }
}

describe('Feature: payments-api, Property 2: Fetching an existing resource returns it with its documented shape', () => {
  it(
    'answers 200 with exactly the documented field set for an existing Product, Customer, Transaction and Delivery',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          productArbitrary,
          customerArbitrary,
          deliveryArbitrary,
          transactionBodyArbitrary,
          providerStatusArbitrary,
          async (product, customer, delivery, body, reportedStatus) => {
            await expectProduct(product);
            await expectCustomer(customer);
            await expectDelivery(delivery);
            await expectTransaction(body, reportedStatus);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
