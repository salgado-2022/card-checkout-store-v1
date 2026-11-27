import { type DynamicModule, Module } from '@nestjs/common';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type AppConfig } from '../config/env.config';
import { ORIGIN_SECRET_PROVIDER, type OriginSecretSource } from '../config/origin-secret.provider';
import type { ProductRepository } from '../../application/ports/product-repository';
import { GetFees } from '../../application/use-cases/get-fees';
import { GetProduct } from '../../application/use-cases/get-product';
import { GetProducts } from '../../application/use-cases/get-products';
import { createDynamoDocumentClient } from '../persistence/dynamodb-client';
import { DynamoProductRepository } from '../persistence/product.repository.dynamodb';
import { SystemClock } from '../system/system-clock';
import { UlidIdGenerator } from '../system/ulid-id-generator';
import { FeesController } from './controllers/fees.controller';
import { HealthController } from './controllers/health.controller';
import { ProductsController } from './controllers/products.controller';
import { ApplicationLoggerAdapter } from './logging/application-logger.adapter';
import { JsonLogger } from './logging/json-logger';
import { OriginGuardMiddleware } from './middleware/origin-guard.middleware';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './middleware/request-logger.middleware';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const APPLICATION_LOGGER = Symbol('APPLICATION_LOGGER');
export const DYNAMODB_DOCUMENT_CLIENT = Symbol('DYNAMODB_DOCUMENT_CLIENT');
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

export interface AppModuleOptions {
  config: AppConfig;
  originSecret: OriginSecretSource;
  logger: JsonLogger;
}

// Wiring only: no logic lives here. Dependencies are passed in so tests can replace them.
// The request middlewares are providers, not consumer routes: createApp mounts them on the
// Express instance so they run for every path, including those outside the global prefix.
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProductsController, FeesController],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        {
          provide: PRODUCT_REPOSITORY,
          useFactory: (client: DynamoDBDocumentClient, config: AppConfig) =>
            new DynamoProductRepository(client, config.tables.products),
          inject: [DYNAMODB_DOCUMENT_CLIENT, APP_CONFIG],
        },
        {
          provide: GetProducts,
          useFactory: (products: ProductRepository) => new GetProducts(products),
          inject: [PRODUCT_REPOSITORY],
        },
        {
          provide: GetProduct,
          useFactory: (products: ProductRepository) => new GetProduct(products),
          inject: [PRODUCT_REPOSITORY],
        },
        {
          provide: GetFees,
          useFactory: (config: AppConfig) =>
            new GetFees({
              baseFeeInCents: config.baseFeeInCents,
              deliveryFeeInCents: config.deliveryFeeInCents,
            }),
          inject: [APP_CONFIG],
        },
        { provide: ORIGIN_SECRET_PROVIDER, useValue: options.originSecret },
        { provide: JsonLogger, useValue: options.logger },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UlidIdGenerator },
        {
          provide: APPLICATION_LOGGER,
          useFactory: (logger: JsonLogger) => new ApplicationLoggerAdapter(logger),
          inject: [JsonLogger],
        },
        { provide: DYNAMODB_DOCUMENT_CLIENT, useFactory: () => createDynamoDocumentClient() },
        RequestIdMiddleware,
        RequestLoggerMiddleware,
        OriginGuardMiddleware,
      ],
    };
  }
}
