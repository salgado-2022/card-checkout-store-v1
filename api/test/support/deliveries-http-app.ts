import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetDelivery } from '../../src/application/use-cases/get-delivery';
import { DeliveriesController } from '../../src/infrastructure/http/controllers/deliveries.controller';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import { createValidationPipe } from '../../src/infrastructure/http/validation-pipe';
import type { InMemoryDeliveryRepository } from './in-memory-delivery-repository';

const silentLogger = { warn: (): void => undefined, error: (): void => undefined };

export interface DeliveriesHttpAppOptions {
  readonly deliveries: InMemoryDeliveryRepository;
}

// Builds the deliveries controller with the real use case over the given in-memory repository.
// The global prefix, validation pipe and exception filter match the bootstrap in create-app.ts.
export async function createDeliveriesHttpApp(
  options: DeliveriesHttpAppOptions,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [DeliveriesController],
    providers: [{ provide: GetDelivery, useFactory: () => new GetDelivery(options.deliveries) }],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(silentLogger));
  await app.init();
  return app;
}
