import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetAcceptanceTokens } from '../../src/application/use-cases/get-acceptance-tokens';
import { AcceptanceTokensController } from '../../src/infrastructure/http/controllers/acceptance-tokens.controller';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import { createValidationPipe } from '../../src/infrastructure/http/validation-pipe';
import type { FakePaymentGateway } from './fake-payment-gateway';
import { FakeApplicationLogger } from './fake-application-logger';

export interface AcceptanceTokensHttpAppOptions {
  readonly gateway: FakePaymentGateway;
  readonly logger?: FakeApplicationLogger;
}

const silentLogger = { warn: (): void => undefined, error: (): void => undefined };

// Builds the acceptance tokens controller with the real use case over the fake gateway. The
// global prefix, validation pipe and exception filter match the bootstrap in create-app.ts.
export async function createAcceptanceTokensHttpApp(
  options: AcceptanceTokensHttpAppOptions,
): Promise<INestApplication> {
  const logger = options.logger ?? new FakeApplicationLogger();
  const moduleRef = await Test.createTestingModule({
    controllers: [AcceptanceTokensController],
    providers: [
      {
        provide: GetAcceptanceTokens,
        useFactory: () => new GetAcceptanceTokens(options.gateway, logger),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(silentLogger));
  await app.init();
  return app;
}
