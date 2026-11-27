import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetFees } from '../../src/application/use-cases/get-fees';
import { GetProduct } from '../../src/application/use-cases/get-product';
import { GetProducts } from '../../src/application/use-cases/get-products';
import { FeesController } from '../../src/infrastructure/http/controllers/fees.controller';
import { ProductsController } from '../../src/infrastructure/http/controllers/products.controller';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import type { FeeSchedule } from '../../src/application/use-cases/get-fees';
import type { InMemoryProductRepository } from './in-memory-product-repository';

export interface CatalogHttpAppOptions {
  readonly products: InMemoryProductRepository;
  readonly fees: FeeSchedule;
}

const silentLogger = { warn: (): void => undefined, error: (): void => undefined };

// Builds the catalog controllers with the real use cases over in-memory fakes. Only the
// application layer is replaced; the global prefix and the exception filter match the bootstrap.
export async function createCatalogHttpApp(
  options: CatalogHttpAppOptions,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProductsController, FeesController],
    providers: [
      { provide: GetProducts, useFactory: () => new GetProducts(options.products) },
      { provide: GetProduct, useFactory: () => new GetProduct(options.products) },
      { provide: GetFees, useFactory: () => new GetFees(options.fees) },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalFilters(new ResultExceptionFilter(silentLogger));
  await app.init();
  return app;
}
