import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createCatalogHttpApp } from '../../../../test/support/catalog-http-app';
import { InMemoryProductRepository } from '../../../../test/support/in-memory-product-repository';

describe('FeesController (HTTP)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 200 with the configured fees in cents and the COP currency', async () => {
    app = await createCatalogHttpApp({
      products: new InMemoryProductRepository(),
      fees: { baseFeeInCents: 300000, deliveryFeeInCents: 800000 },
    });

    const response = await request(app.getHttpServer()).get('/api/v1/fees');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      currency: 'COP',
      baseFeeInCents: 300000,
      deliveryFeeInCents: 800000,
    });
  });

  it('echoes non-default fee values exactly as configured', async () => {
    app = await createCatalogHttpApp({
      products: new InMemoryProductRepository(),
      fees: { baseFeeInCents: 0, deliveryFeeInCents: 12345 },
    });

    const response = await request(app.getHttpServer()).get('/api/v1/fees');

    expect(response.body).toEqual({
      currency: 'COP',
      baseFeeInCents: 0,
      deliveryFeeInCents: 12345,
    });
  });
});
