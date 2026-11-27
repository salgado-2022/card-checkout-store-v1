import type { INestApplication } from '@nestjs/common';
import * as fc from 'fast-check';
import request from 'supertest';
import {
  customerArbitrary,
  type CustomerPayload,
} from '../../../../test/support/customer-payload-arbitraries';
import { createCustomersHttpApp } from '../../../../test/support/customers-http-app';
import { InMemoryCustomerRepository } from '../../../../test/support/in-memory-customer-repository';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  expectNoTransactionWrites,
  postTransaction,
  validIdempotencyKeyArbitrary,
  validTransactionBodyArbitrary,
  withField,
  type PlainBody,
} from '../../../../test/support/transaction-request-fixtures';
import { DOCUMENT_TYPES } from '../dto/create-customer.dto';
import { COLOMBIAN_DEPARTMENTS } from '../dto/create-transaction.dto';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 120_000;
const CUSTOMERS_PATH = '/api/v1/customers';
const IDEMPOTENCY_FIELD = 'Idempotency-Key';

interface FieldMutation {
  /** Name as it appears in `details`: the field itself, or the dotted path of a nested field. */
  readonly label: string;
  readonly path: readonly string[];
  /** class-validator rules that may fail for the invalid value. */
  readonly rules: readonly string[];
  readonly invalid: fc.Arbitrary<unknown>;
}

const customerMutations: readonly FieldMutation[] = [
  {
    label: 'fullName',
    path: ['fullName'],
    rules: ['isLength'],
    invalid: fc.oneof(
      fc.stringMatching(/^[A-Za-z]{0,2}$/),
      fc.stringMatching(/^[A-Za-z]{81,100}$/),
    ),
  },
  {
    label: 'email',
    path: ['email'],
    rules: ['isEmail', 'maxLength'],
    invalid: fc.oneof(
      fc.stringMatching(/^[a-z]{3,12}$/),
      fc.stringMatching(/^[a-z]{110,130}@example\.com$/),
    ),
  },
  {
    label: 'phone',
    path: ['phone'],
    rules: ['matches'],
    invalid: fc.oneof(
      fc.stringMatching(/^[0-2456789]\d{9}$/),
      fc.stringMatching(/^3\d{0,8}$/),
      fc.stringMatching(/^3\d{10,12}$/),
    ),
  },
  {
    label: 'documentType',
    path: ['documentType'],
    rules: ['isIn'],
    invalid: fc
      .stringMatching(/^[A-Z]{1,6}$/)
      .filter((value) => !(DOCUMENT_TYPES as readonly string[]).includes(value)),
  },
  {
    label: 'documentNumber',
    path: ['documentNumber'],
    rules: ['isDocumentNumberForType'],
    invalid: fc.stringMatching(/^[A-Za-z0-9]{1,5}$/),
  },
];

const transactionMutations: readonly FieldMutation[] = [
  { label: 'productId', path: ['productId'], rules: ['isLength'], invalid: fc.constant('') },
  {
    label: 'quantity',
    path: ['quantity'],
    rules: ['min', 'max', 'isInt'],
    invalid: fc.oneof(
      fc.integer({ min: -1000, max: 0 }),
      fc.integer({ min: 6, max: 1000 }),
      fc.double({ min: 0.5, max: 4.5, noInteger: true, noNaN: true }),
    ),
  },
  { label: 'customerId', path: ['customerId'], rules: ['isLength'], invalid: fc.constant('') },
  {
    label: 'delivery.recipientName',
    path: ['delivery', 'recipientName'],
    rules: ['isLength'],
    invalid: fc.stringMatching(/^[A-Za-z]{0,2}$/),
  },
  {
    label: 'delivery.phone',
    path: ['delivery', 'phone'],
    rules: ['matches'],
    invalid: fc.oneof(
      fc.stringMatching(/^[0-2456789]\d{9}$/),
      fc.stringMatching(/^3\d{0,8}$/),
      fc.stringMatching(/^3\d{10,12}$/),
    ),
  },
  {
    label: 'delivery.addressLine1',
    path: ['delivery', 'addressLine1'],
    rules: ['isLength'],
    invalid: fc.stringMatching(/^[A-Za-z]{0,4}$/),
  },
  {
    label: 'delivery.addressLine2',
    path: ['delivery', 'addressLine2'],
    rules: ['maxLength'],
    invalid: fc.stringMatching(/^[A-Za-z]{61,80}$/),
  },
  {
    label: 'delivery.city',
    path: ['delivery', 'city'],
    rules: ['isLength'],
    invalid: fc.stringMatching(/^[A-Za-z]{0,1}$/),
  },
  {
    label: 'delivery.department',
    path: ['delivery', 'department'],
    rules: ['isIn'],
    invalid: fc
      .stringMatching(/^[A-Za-z]{3,12}$/)
      .filter((value) => !COLOMBIAN_DEPARTMENTS.includes(value)),
  },
  {
    label: 'delivery.postalCode',
    path: ['delivery', 'postalCode'],
    rules: ['matches'],
    invalid: fc.oneof(fc.stringMatching(/^\d{1,5}$/), fc.stringMatching(/^\d{7,9}$/)),
  },
  {
    label: 'payment.installments',
    path: ['payment', 'installments'],
    rules: ['min', 'max'],
    invalid: fc.oneof(fc.integer({ min: -100, max: 0 }), fc.integer({ min: 37, max: 1000 })),
  },
  {
    label: 'payment.brand',
    path: ['payment', 'brand'],
    rules: ['isIn'],
    invalid: fc
      .stringMatching(/^[A-Z]{2,6}$/)
      .filter((value) => value !== 'VISA' && value !== 'MASTERCARD'),
  },
  {
    label: 'payment.lastFour',
    path: ['payment', 'lastFour'],
    rules: ['matches'],
    invalid: fc.oneof(fc.stringMatching(/^\d{0,3}$/), fc.stringMatching(/^\d{5,8}$/)),
  },
  {
    label: 'payment.cardToken',
    path: ['payment', 'cardToken'],
    rules: ['isLength'],
    invalid: fc.constant(''),
  },
  {
    label: 'acceptanceToken',
    path: ['acceptanceToken'],
    rules: ['isLength'],
    invalid: fc.constant(''),
  },
  {
    label: 'acceptPersonalAuth',
    path: ['acceptPersonalAuth'],
    rules: ['isLength'],
    invalid: fc.constant(''),
  },
];

// Characters that are printable but never allowed in the key. Space is left out on purpose: the
// HTTP parser trims leading and trailing spaces, so a key ending in a space would be valid.
const FORBIDDEN_KEY_CHARACTERS = ['!', '#', '/', '+', '*', '~', ':', '@'] as const;

// Keys that break the Idempotency-Key rule: too short, too long, or with a forbidden character.
const invalidIdempotencyKeyArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9._-]{1,7}$/),
  fc.stringMatching(/^[A-Za-z0-9._-]{129,160}$/),
  fc
    .tuple(
      fc.stringMatching(/^[A-Za-z0-9]{8,40}$/),
      fc.constantFrom(...FORBIDDEN_KEY_CHARACTERS),
      fc.boolean(),
    )
    .map(([base, forbidden, prepend]) => (prepend ? `${forbidden}${base}` : `${base}${forbidden}`)),
);

function mutationArbitrary(mutations: readonly FieldMutation[]): fc.Arbitrary<{
  readonly mutation: FieldMutation;
  readonly value: unknown;
}> {
  return fc
    .constantFrom(...mutations)
    .chain((mutation) => mutation.invalid.map((value) => ({ mutation, value })));
}

function expectNamedRule(details: unknown, mutation: FieldMutation): void {
  const entries = details as string[];
  const named = mutation.rules.some((rule) => entries.includes(`${mutation.label}: ${rule}`));
  expect(named).toBe(true);
}

// Feature: payments-api, Property 7: Field-level validation rejects out-of-rule values and names the field
describe('Feature: payments-api, Property 7: Field-level validation rejects out-of-rule values and names the field', () => {
  let customersApp: INestApplication | undefined;

  afterEach(async () => {
    await customersApp?.close();
    customersApp = undefined;
  });

  it(
    'rejects one out-of-rule customer field with 400 VALIDATION_ERROR naming the field and rule, and no write',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          customerArbitrary,
          mutationArbitrary(customerMutations),
          async (payload: CustomerPayload, { mutation, value }) => {
            const customers = new InMemoryCustomerRepository();
            const upsertSpy = jest.spyOn(customers, 'upsert');
            customersApp = await createCustomersHttpApp({ customers });
            const body = withField({ ...payload }, mutation.path, value);

            const response = await request(customersApp.getHttpServer())
              .post(CUSTOMERS_PATH)
              .set('Content-Type', 'application/json')
              .send(JSON.stringify(body));

            expect(response.status).toBe(400);
            expect(response.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
            expectNamedRule(response.body.details, mutation);
            expect(upsertSpy).not.toHaveBeenCalled();
            expect(customers.count()).toBe(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'rejects one out-of-rule transaction field with 400 VALIDATION_ERROR naming the field and rule, and no write',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validTransactionBodyArbitrary,
          validIdempotencyKeyArbitrary,
          mutationArbitrary(transactionMutations),
          async (body: PlainBody, key, { mutation, value }) => {
            const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
            try {
              const broken = withField(body, mutation.path, value);

              const response = await postTransaction(testApp, JSON.stringify(broken), key);

              expect(response.status).toBe(400);
              expect(response.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
              expectNamedRule(response.body.details, mutation);
              expectNoTransactionWrites(testApp);
              expect(testApp.idempotency.get(key)).toBeUndefined();
            } finally {
              await testApp.app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'rejects an Idempotency-Key outside its charset or length with 400 VALIDATION_ERROR naming the header, and no write',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validTransactionBodyArbitrary,
          invalidIdempotencyKeyArbitrary,
          async (body: PlainBody, key) => {
            const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
            const beginSpy = jest.spyOn(testApp.idempotency, 'begin');
            try {
              const response = await postTransaction(testApp, JSON.stringify(body), key);

              expect(response.status).toBe(400);
              expect(response.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
              expect(response.body.details).toEqual([
                expect.stringMatching(new RegExp(`^${IDEMPOTENCY_FIELD}: `)),
              ]);
              expectNoTransactionWrites(testApp);
              expect(beginSpy).not.toHaveBeenCalled();
            } finally {
              await testApp.app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
