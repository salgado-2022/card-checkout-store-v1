import type { INestApplication } from '@nestjs/common';
import * as fc from 'fast-check';
import request from 'supertest';
import { createCustomersHttpApp } from '../../../../test/support/customers-http-app';
import {
  customerArbitrary,
  type CustomerPayload,
} from '../../../../test/support/customer-payload-arbitraries';
import { InMemoryCustomerRepository } from '../../../../test/support/in-memory-customer-repository';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const CUSTOMERS_PATH = '/api/v1/customers';

// Undeclared names shaped like money, identifiers and timestamps. They must never be accepted.
const AMOUNT_SHAPED_NAMES = [
  'amount',
  'amountInCents',
  'totalInCents',
  'subtotalInCents',
  'baseFeeInCents',
  'deliveryFeeInCents',
  'priceInCents',
  'total',
  'price',
  'id',
  'createdAt',
  'updatedAt',
  'status',
  'role',
  'isAdmin',
] as const;

const DECLARED_FIELDS: ReadonlySet<string> = new Set([
  'fullName',
  'email',
  'phone',
  'documentType',
  'documentNumber',
]);

// Object.prototype names. They are generated on purpose: `__proto__` and `constructor` are dropped
// by class-transformer, and `toString` or `hasOwnProperty` pass class-validator's whitelist check.
// The global ValidationPipe rejects all of them before transformation (requirement 14.6).
const OBJECT_PROTOTYPE_NAMES = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
] as const;

const randomNameArbitrary = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,24}$/)
  .filter((name) => !DECLARED_FIELDS.has(name));

const unknownNameArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...AMOUNT_SHAPED_NAMES),
  fc.constantFrom(...OBJECT_PROTOTYPE_NAMES),
  randomNameArbitrary,
);

const unknownValueArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
);

// Builds the raw JSON text of a valid payload plus one undeclared property. The extra member is
// serialized on its own with JSON.stringify and spliced in before the closing brace, so the body
// text is exactly what a client would send, regardless of the property name.
function bodyWithUnknownProperty(payload: CustomerPayload, name: string, value: unknown): string {
  const base = JSON.stringify(payload).slice(0, -1);
  const extra = JSON.stringify({ [name]: value }).slice(1, -1);
  return `${base},${extra}}`;
}

// Feature: payments-api, Property 8: Unknown or malformed request bodies are rejected on customers and transactions (customers part)
describe('Feature: payments-api, Property 8: Unknown or malformed request bodies are rejected on customers and transactions (customers part)', () => {
  it(
    'rejects a valid customer body with an undeclared property with 400 VALIDATION_ERROR and no write',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          customerArbitrary,
          unknownNameArbitrary,
          unknownValueArbitrary,
          async (payload, name, value) => {
            const customers = new InMemoryCustomerRepository();
            const upsertSpy = jest.spyOn(customers, 'upsert');
            const app: INestApplication = await createCustomersHttpApp({ customers });
            try {
              const body = bodyWithUnknownProperty(payload, name, value);
              const response = await request(app.getHttpServer())
                .post(CUSTOMERS_PATH)
                .set('Content-Type', 'application/json')
                .send(body);

              expect(response.status).toBe(400);
              expect(response.body).toMatchObject({
                statusCode: 400,
                code: 'VALIDATION_ERROR',
              });
              expect((response.body as { details: string[] }).details).toContain(
                `${name}: whitelistValidation`,
              );
              expect(upsertSpy).not.toHaveBeenCalled();
              expect(customers.count()).toBe(0);
            } finally {
              await app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
