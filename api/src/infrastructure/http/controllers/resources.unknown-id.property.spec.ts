import * as fc from 'fast-check';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createCatalogHttpApp } from '../../../../test/support/catalog-http-app';
import { createCustomersHttpApp } from '../../../../test/support/customers-http-app';
import { createDeliveriesHttpApp } from '../../../../test/support/deliveries-http-app';
import { InMemoryCustomerRepository } from '../../../../test/support/in-memory-customer-repository';
import { InMemoryDeliveryRepository } from '../../../../test/support/in-memory-delivery-repository';
import { InMemoryProductRepository } from '../../../../test/support/in-memory-product-repository';
import { createTransactionsHttpApp } from '../../../../test/support/transactions-http-app';
import {
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
} from '../../../../test/support/transaction-property-helpers';

// Feature: payments-api, Property 3: An id that matches no record always yields the resource's not-found code

const FEES = { baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 };

/** Every stored id has this shape, so a valid ULID that is absent is the "well formed" case. */
const absentUlidArbitrary = fc.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

/**
 * Ids that match no record: absent ULIDs, garbage (full Unicode, control characters, separators),
 * and very long values. `.` and `..` are excluded because URL normalization rewrites them into
 * another path before the router sees them, which is not a lookup at all.
 */
const unknownIdArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    absentUlidArbitrary,
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 64 }),
    fc.string({ minLength: 1, maxLength: 3_000 }),
    fc.stringMatching(/^[a-z0-9/_%.:?#-]{1,80}$/),
  )
  .filter((value) => value !== '.' && value !== '..');

// Feature: payments-api, Property 3: An id that matches no record always yields the resource's not-found code
describe("Feature: payments-api, Property 3: An id that matches no record always yields the resource's not-found code", () => {
  it(
    'answers 404 with the resource-specific code and never 500 for an id that matches no record',
    async () => {
      await fc.assert(
        fc.asyncProperty(unknownIdArbitrary, async (id) => {
          const products = await createCatalogHttpApp({
            products: new InMemoryProductRepository([]),
            fees: FEES,
          });
          const customers = await createCustomersHttpApp({
            customers: new InMemoryCustomerRepository([]),
          });
          const deliveries = await createDeliveriesHttpApp({
            deliveries: new InMemoryDeliveryRepository(),
          });
          const transactions = await createTransactionsHttpApp();
          try {
            const cases: Array<{ path: string; code: string; server: INestApplication }> = [
              { path: '/api/v1/products/', code: 'PRODUCT_NOT_FOUND', server: products },
              { path: '/api/v1/customers/', code: 'CUSTOMER_NOT_FOUND', server: customers },
              {
                path: '/api/v1/transactions/',
                code: 'TRANSACTION_NOT_FOUND',
                server: transactions.app,
              },
              { path: '/api/v1/deliveries/', code: 'DELIVERY_NOT_FOUND', server: deliveries },
            ];
            for (const { path, code, server } of cases) {
              const response = await request(server.getHttpServer()).get(
                `${path}${encodeURIComponent(id)}`,
              );
              expect(response.status).not.toBe(500);
              expect(response.status).toBe(404);
              expect(response.body).toMatchObject({ statusCode: 404, code });
            }
          } finally {
            await Promise.all([
              products.close(),
              customers.close(),
              deliveries.close(),
              transactions.app.close(),
            ]);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
