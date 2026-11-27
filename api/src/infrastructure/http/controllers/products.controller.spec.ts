import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Product } from '../../../domain/entities';
import { InMemoryProductRepository } from '../../../../test/support/in-memory-product-repository';
import { createCatalogHttpApp } from '../../../../test/support/catalog-http-app';

const ID_HEADPHONES = '01J9Z3K5M7N8P0Q2R4S6T8V0W1';
const ID_KEYBOARD = '01J9Z3K5M7N8P0Q2R4S6T8V0W2';
const ID_CHARGER = '01J9Z3K5M7N8P0Q2R4S6T8V0W3';

const PRODUCTS: readonly Product[] = [
  {
    id: ID_KEYBOARD,
    sku: 'SKU-0002',
    name: 'Teclado mecánico',
    description: 'Teclado con interruptores lineales.',
    imageUrl: '/images/teclado.webp',
    priceInCents: 9000000,
    currency: 'COP',
    stock: 0,
  },
  {
    id: ID_HEADPHONES,
    sku: 'SKU-0001',
    name: 'Auriculares inalámbricos',
    description: 'Auriculares con cancelación de ruido.',
    imageUrl: '/images/auriculares.webp',
    priceInCents: 12000000,
    currency: 'COP',
    stock: 5,
  },
  {
    id: ID_CHARGER,
    sku: 'SKU-0003',
    name: 'Cargador USB-C',
    description: 'Cargador de 65 W.',
    imageUrl: '/images/cargador.webp',
    priceInCents: 4500000,
    currency: 'COP',
    stock: 1,
  },
];

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

const PRODUCT_NOT_FOUND_BODY = {
  statusCode: 404,
  code: 'PRODUCT_NOT_FOUND',
  message: 'Product not found.',
  details: [],
};

describe('ProductsController (HTTP)', () => {
  let app: INestApplication;
  let products: InMemoryProductRepository;

  beforeEach(async () => {
    products = new InMemoryProductRepository(PRODUCTS);
    app = await createCatalogHttpApp({
      products,
      fees: { baseFeeInCents: 0, deliveryFeeInCents: 0 },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/products', () => {
    it('returns 200 with every product sorted by name and exactly the catalog fields', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/products');

      expect(response.status).toBe(200);
      expect(response.body.map((product: Product) => product.name)).toEqual([
        'Auriculares inalámbricos',
        'Cargador USB-C',
        'Teclado mecánico',
      ]);
      for (const product of response.body as Record<string, unknown>[]) {
        expect(Object.keys(product).sort()).toEqual(EXPECTED_FIELDS);
      }
    });

    it('keeps a product with stock 0 in the list', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/products');

      expect(response.body).toContainEqual(expect.objectContaining({ id: ID_KEYBOARD, stock: 0 }));
    });

    it('returns 200 with an empty array when the catalog is empty', async () => {
      await app.close();
      app = await createCatalogHttpApp({
        products: new InMemoryProductRepository(),
        fees: { baseFeeInCents: 0, deliveryFeeInCents: 0 },
      });

      const response = await request(app.getHttpServer()).get('/api/v1/products');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('returns 500 INTERNAL_ERROR without leaking the repository failure', async () => {
      products.failure = {
        kind: 'REPOSITORY_ERROR',
        reason: 'ProvisionedThroughputExceededException',
      };

      const response = await request(app.getHttpServer()).get('/api/v1/products');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: [],
      });
      expect(JSON.stringify(response.body)).not.toContain('Provisioned');
    });
  });

  describe('GET /api/v1/products/:id', () => {
    it('returns 200 with the exact product shape for an existing id', async () => {
      const response = await request(app.getHttpServer()).get(`/api/v1/products/${ID_HEADPHONES}`);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(EXPECTED_FIELDS);
      expect(response.body).toEqual({
        id: ID_HEADPHONES,
        sku: 'SKU-0001',
        name: 'Auriculares inalámbricos',
        description: 'Auriculares con cancelación de ruido.',
        imageUrl: '/images/auriculares.webp',
        priceInCents: 12000000,
        currency: 'COP',
        stock: 5,
      });
    });

    it('returns 404 PRODUCT_NOT_FOUND for an id that does not exist', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/products/01J9Z3K5M7N8P0Q2R4S6T8ZZZZ',
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual(PRODUCT_NOT_FOUND_BODY);
    });

    it('returns 404 PRODUCT_NOT_FOUND for a malformed id', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/products/not-a-ulid!');

      expect(response.status).toBe(404);
      expect(response.body).toEqual(PRODUCT_NOT_FOUND_BODY);
    });

    it('returns 500 INTERNAL_ERROR when the repository fails', async () => {
      products.failure = { kind: 'REPOSITORY_ERROR', reason: 'ResourceNotFoundException' };

      const response = await request(app.getHttpServer()).get(`/api/v1/products/${ID_HEADPHONES}`);

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
    });
  });
});
