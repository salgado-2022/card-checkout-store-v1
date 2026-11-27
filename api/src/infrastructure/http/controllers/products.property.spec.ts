import type { INestApplication } from '@nestjs/common';
import * as fc from 'fast-check';
import request from 'supertest';
import type { Product } from '../../../domain/entities';
import { createCatalogHttpApp } from '../../../../test/support/catalog-http-app';
import { InMemoryProductRepository } from '../../../../test/support/in-memory-product-repository';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const EXPECTED_FIELDS = [
  'currency',
  'description',
  'id',
  'imageUrl',
  'name',
  'priceInCents',
  'sku',
  'stock',
];

const productArbitrary = fc.record({
  id: fc.string({
    unit: fc.constantFrom(...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('')),
    minLength: 26,
    maxLength: 26,
  }),
  sku: fc.string({ minLength: 1, maxLength: 20 }),
  name: fc.string({ minLength: 1, maxLength: 40 }),
  description: fc.string({ maxLength: 80 }),
  imageUrl: fc.string({ minLength: 1, maxLength: 40 }),
  priceInCents: fc.integer({ min: 0, max: 1_000_000_000_000 }),
  currency: fc.constant('COP'),
  // Stock 0 is a valid catalog state (sold out) and must still be listed.
  stock: fc.integer({ min: 0, max: 20 }),
});

// Unique ids: the in-memory repository keys its products by id.
const productSetArbitrary = fc.uniqueArray(productArbitrary, {
  minLength: 0,
  maxLength: 8,
  selector: (product) => product.id,
});

// Same comparison as GetProducts: plain code-unit order on name.
function compareByName(a: Product, b: Product): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

// Feature: payments-api, Property 1: Products are listed completely, sorted, with the exact field set
describe('Feature: payments-api, Property 1: Products are listed completely, sorted, with the exact field set', () => {
  it(
    'returns every product, sorted by name ascending, with exactly the eight catalog fields',
    async () => {
      await fc.assert(
        fc.asyncProperty(productSetArbitrary, async (products) => {
          const app: INestApplication = await createCatalogHttpApp({
            products: new InMemoryProductRepository(products),
            fees: { baseFeeInCents: 0, deliveryFeeInCents: 0 },
          });
          try {
            const response = await request(app.getHttpServer()).get('/api/v1/products');
            expect(response.status).toBe(200);

            const body = response.body as Array<Record<string, unknown>>;
            expect(body).toHaveLength(products.length);

            const names = body.map((item) => String(item['name']));
            expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

            const expectedById = new Map(products.map((product) => [product.id, product]));
            expect(new Set(body.map((item) => item['id']))).toEqual(new Set(expectedById.keys()));

            for (const item of body) {
              expect(Object.keys(item).sort()).toEqual(EXPECTED_FIELDS);
              expect(item).toEqual(expectedById.get(String(item['id'])));
            }
            expect([...products].sort(compareByName).map((product) => product.name)).toEqual(names);
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
