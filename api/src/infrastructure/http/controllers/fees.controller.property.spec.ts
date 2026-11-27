import type { INestApplication } from '@nestjs/common';
import * as fc from 'fast-check';
import request from 'supertest';
import { createCatalogHttpApp } from '../../../../test/support/catalog-http-app';
import { InMemoryProductRepository } from '../../../../test/support/in-memory-product-repository';
import { DEFAULT_BASE_FEE_IN_CENTS, DEFAULT_DELIVERY_FEE_IN_CENTS } from '../../config/env.schema';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;

interface FeePair {
  readonly baseFeeInCents: number;
  readonly deliveryFeeInCents: number;
}

// Non-negative integers in cents, plus the configured defaults, which must be covered explicitly.
const feeAmountArbitrary = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const feePairArbitrary: fc.Arbitrary<FeePair> = fc.oneof(
  fc.constant({
    baseFeeInCents: DEFAULT_BASE_FEE_IN_CENTS,
    deliveryFeeInCents: DEFAULT_DELIVERY_FEE_IN_CENTS,
  }),
  fc.record({ baseFeeInCents: feeAmountArbitrary, deliveryFeeInCents: feeAmountArbitrary }),
);

// Feature: payments-api, Property 5: Fees echo the configured values
describe('Feature: payments-api, Property 5: Fees echo the configured values', () => {
  it(
    'returns 200 with the COP currency and exactly the configured fee pair',
    async () => {
      await fc.assert(
        fc.asyncProperty(feePairArbitrary, async (fees) => {
          const app: INestApplication = await createCatalogHttpApp({
            products: new InMemoryProductRepository(),
            fees,
          });
          try {
            const response = await request(app.getHttpServer()).get('/api/v1/fees');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
              currency: 'COP',
              baseFeeInCents: fees.baseFeeInCents,
              deliveryFeeInCents: fees.deliveryFeeInCents,
            });
          } finally {
            await app.close();
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
