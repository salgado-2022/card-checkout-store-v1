import { type DynamicModule, Module } from '@nestjs/common';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type AppConfig } from '../config/env.config';
import { ORIGIN_SECRET_PROVIDER, type OriginSecretSource } from '../config/origin-secret.provider';
import type { ApplicationLogger } from '../../application/ports/application-logger';
import type { Clock } from '../../application/ports/clock';
import type { CustomerRepository } from '../../application/ports/customer-repository';
import type { IdGenerator } from '../../application/ports/id-generator';
import type { ProductRepository } from '../../application/ports/product-repository';
import { GetAcceptanceTokens } from '../../application/use-cases/get-acceptance-tokens';
import { GetCustomer } from '../../application/use-cases/get-customer';
import { GetFees } from '../../application/use-cases/get-fees';
import { GetProduct } from '../../application/use-cases/get-product';
import { GetProducts } from '../../application/use-cases/get-products';
import { UpsertCustomer } from '../../application/use-cases/upsert-customer';
import {
  PaymentGatewayAdapter,
  type PaymentGatewayAcceptance,
} from '../payment/payment-gateway.adapter';
import { DynamoCustomerRepository } from '../persistence/customer.repository.dynamodb';
import { createDynamoDocumentClient } from '../persistence/dynamodb-client';
import { DynamoProductRepository } from '../persistence/product.repository.dynamodb';
import { SystemClock } from '../system/system-clock';
import { UlidIdGenerator } from '../system/ulid-id-generator';
import { AcceptanceTokensController } from './controllers/acceptance-tokens.controller';
import { CustomersController } from './controllers/customers.controller';
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
export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

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
      controllers: [
        HealthController,
        ProductsController,
        FeesController,
        CustomersController,
        AcceptanceTokensController,
      ],
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
          provide: CUSTOMER_REPOSITORY,
          useFactory: (client: DynamoDBDocumentClient, config: AppConfig) =>
            new DynamoCustomerRepository(client, config.tables.customers),
          inject: [DYNAMODB_DOCUMENT_CLIENT, APP_CONFIG],
        },
        {
          provide: UpsertCustomer,
          useFactory: (
            customers: CustomerRepository,
            ids: IdGenerator,
            clock: Clock,
            logger: ApplicationLogger,
          ) => new UpsertCustomer(customers, ids, clock, logger),
          inject: [CUSTOMER_REPOSITORY, ID_GENERATOR, CLOCK, APPLICATION_LOGGER],
        },
        {
          provide: GetCustomer,
          useFactory: (customers: CustomerRepository) => new GetCustomer(customers),
          inject: [CUSTOMER_REPOSITORY],
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
        {
          provide: PAYMENT_GATEWAY,
          useFactory: (config: AppConfig) =>
            new PaymentGatewayAdapter({
              paymentApiUrl: config.paymentApiUrl,
              paymentPublicKey: config.paymentPublicKey,
            }),
          inject: [APP_CONFIG],
        },
        {
          provide: GetAcceptanceTokens,
          useFactory: (gateway: PaymentGatewayAcceptance, logger: ApplicationLogger) =>
            new GetAcceptanceTokens(gateway, logger),
          inject: [PAYMENT_GATEWAY, APPLICATION_LOGGER],
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
