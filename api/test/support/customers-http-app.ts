import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetCustomer } from '../../src/application/use-cases/get-customer';
import { UpsertCustomer } from '../../src/application/use-cases/upsert-customer';
import { CustomersController } from '../../src/infrastructure/http/controllers/customers.controller';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import { createValidationPipe } from '../../src/infrastructure/http/validation-pipe';
import type { InMemoryCustomerRepository } from './in-memory-customer-repository';
import { FakeApplicationLogger } from './fake-application-logger';
import { FakeClock } from './fake-clock';
import { FakeIdGenerator } from './fake-id-generator';

export interface CustomersHttpAppOptions {
  readonly customers: InMemoryCustomerRepository;
  readonly clock?: FakeClock;
}

const silentLogger = { warn: (): void => undefined, error: (): void => undefined };

// Builds the customers controller with the real use cases over in-memory fakes. Only the
// persistence and the clock/id/logger ports are replaced. The global prefix, validation pipe and
// exception filter match the bootstrap in create-app.ts.
export async function createCustomersHttpApp(
  options: CustomersHttpAppOptions,
): Promise<INestApplication> {
  const clock = options.clock ?? new FakeClock();
  const ids = new FakeIdGenerator();
  const logger = new FakeApplicationLogger();
  const moduleRef = await Test.createTestingModule({
    controllers: [CustomersController],
    providers: [
      {
        provide: UpsertCustomer,
        useFactory: () => new UpsertCustomer(options.customers, ids, clock, logger),
      },
      { provide: GetCustomer, useFactory: () => new GetCustomer(options.customers) },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(silentLogger));
  await app.init();
  return app;
}
