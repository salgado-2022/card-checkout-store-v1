import { type DynamicModule, Module } from '@nestjs/common';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type AppConfig } from '../config/env.config';
import { ORIGIN_SECRET_PROVIDER, type OriginSecretSource } from '../config/origin-secret.provider';
import type { ApplicationLogger } from '../../application/ports/application-logger';
import type { Clock } from '../../application/ports/clock';
import type { CustomerRepository } from '../../application/ports/customer-repository';
import type { IdGenerator } from '../../application/ports/id-generator';
import type { ProductRepository } from '../../application/ports/product-repository';
import type { DeliveryRepository } from '../../application/ports/delivery-repository';
import type { IdempotencyRepository } from '../../application/ports/idempotency-repository';
import type { TransactionRepository } from '../../application/ports/transaction-repository';
import { CreateTransaction } from '../../application/use-cases/create-transaction';
import { FinalizeTransaction } from '../../application/use-cases/finalize-transaction';
import { GetAcceptanceTokens } from '../../application/use-cases/get-acceptance-tokens';
import { GetCustomer } from '../../application/use-cases/get-customer';
import { GetFees } from '../../application/use-cases/get-fees';
import { GetProduct } from '../../application/use-cases/get-product';
import { GetProducts } from '../../application/use-cases/get-products';
import { GetDelivery } from '../../application/use-cases/get-delivery';
import { SyncTransactionStatus } from '../../application/use-cases/sync-transaction-status';
import { UpsertCustomer } from '../../application/use-cases/upsert-customer';
import {
  PaymentGatewayAdapter,
  type PaymentGatewayAcceptance,
} from '../payment/payment-gateway.adapter';
import { DynamoCustomerRepository } from '../persistence/customer.repository.dynamodb';
import { DynamoDeliveryRepository } from '../persistence/delivery.repository.dynamodb';
import { DynamoIdempotencyRepository } from '../persistence/idempotency.repository.dynamodb';
import { createDynamoDocumentClient } from '../persistence/dynamodb-client';
import { DynamoProductRepository } from '../persistence/product.repository.dynamodb';
import { DynamoTransactionRepository } from '../persistence/transaction.repository.dynamodb';
import { SystemClock } from '../system/system-clock';
import { UlidIdGenerator } from '../system/ulid-id-generator';
import { AcceptanceTokensController } from './controllers/acceptance-tokens.controller';
import { CustomersController } from './controllers/customers.controller';
import { FeesController } from './controllers/fees.controller';
import { HealthController } from './controllers/health.controller';
import { ProductsController } from './controllers/products.controller';
import { TransactionsController } from './controllers/transactions.controller';
import { DeliveriesController } from './controllers/deliveries.controller';
import { RateLimitModule } from './security/rate-limit.module';
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
export const IDEMPOTENCY_REPOSITORY = Symbol('IDEMPOTENCY_REPOSITORY');
export const DELIVERY_REPOSITORY = Symbol('DELIVERY_REPOSITORY');
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');

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
      imports: [RateLimitModule],
      controllers: [
        HealthController,
        ProductsController,
        FeesController,
        CustomersController,
        AcceptanceTokensController,
        TransactionsController,
        DeliveriesController,
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
              paymentPrivateKeyParam: config.paymentPrivateKeyParam,
              paymentIntegritySecretParam: config.paymentIntegritySecretParam,
            }),
          inject: [APP_CONFIG],
        },
        {
          provide: GetAcceptanceTokens,
          useFactory: (gateway: PaymentGatewayAcceptance, logger: ApplicationLogger) =>
            new GetAcceptanceTokens(gateway, logger),
          inject: [PAYMENT_GATEWAY, APPLICATION_LOGGER],
        },
        {
          provide: IDEMPOTENCY_REPOSITORY,
          useFactory: (client: DynamoDBDocumentClient, config: AppConfig, clock: Clock) =>
            new DynamoIdempotencyRepository(client, config.tables.idempotencyKeys, clock),
          inject: [DYNAMODB_DOCUMENT_CLIENT, APP_CONFIG, CLOCK],
        },
        {
          provide: DELIVERY_REPOSITORY,
          useFactory: (client: DynamoDBDocumentClient, config: AppConfig) =>
            new DynamoDeliveryRepository(client, config.tables.deliveries),
          inject: [DYNAMODB_DOCUMENT_CLIENT, APP_CONFIG],
        },
        {
          provide: TRANSACTION_REPOSITORY,
          useFactory: (client: DynamoDBDocumentClient, config: AppConfig) =>
            new DynamoTransactionRepository(client, config.tables.transactions, {
              deliveries: config.tables.deliveries,
              products: config.tables.products,
            }),
          inject: [DYNAMODB_DOCUMENT_CLIENT, APP_CONFIG],
        },
        {
          provide: FinalizeTransaction,
          useFactory: (
            transactions: TransactionRepository,
            logger: ApplicationLogger,
            clock: Clock,
          ) => new FinalizeTransaction(transactions, logger, clock),
          inject: [TRANSACTION_REPOSITORY, APPLICATION_LOGGER, CLOCK],
        },
        {
          provide: GetDelivery,
          useFactory: (deliveries: DeliveryRepository) => new GetDelivery(deliveries),
          inject: [DELIVERY_REPOSITORY],
        },
        {
          provide: SyncTransactionStatus,
          useFactory: (
            transactions: TransactionRepository,
            gateway: PaymentGatewayAdapter,
            finalize: FinalizeTransaction,
            logger: ApplicationLogger,
            clock: Clock,
          ) => new SyncTransactionStatus(transactions, gateway, finalize, logger, clock),
          inject: [
            TRANSACTION_REPOSITORY,
            PAYMENT_GATEWAY,
            FinalizeTransaction,
            APPLICATION_LOGGER,
            CLOCK,
          ],
        },
        {
          provide: CreateTransaction,
          useFactory: (
            config: AppConfig,
            idempotency: IdempotencyRepository,
            products: ProductRepository,
            customers: CustomerRepository,
            transactions: TransactionRepository,
            deliveries: DeliveryRepository,
            gateway: PaymentGatewayAdapter,
            finalize: FinalizeTransaction,
            ids: IdGenerator,
            clock: Clock,
            logger: ApplicationLogger,
          ) =>
            new CreateTransaction(
              idempotency,
              products,
              customers,
              transactions,
              deliveries,
              gateway,
              finalize,
              {
                baseFeeInCents: config.baseFeeInCents,
                deliveryFeeInCents: config.deliveryFeeInCents,
              },
              ids,
              clock,
              logger,
            ),
          inject: [
            APP_CONFIG,
            IDEMPOTENCY_REPOSITORY,
            PRODUCT_REPOSITORY,
            CUSTOMER_REPOSITORY,
            TRANSACTION_REPOSITORY,
            DELIVERY_REPOSITORY,
            PAYMENT_GATEWAY,
            FinalizeTransaction,
            ID_GENERATOR,
            CLOCK,
            APPLICATION_LOGGER,
          ],
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
