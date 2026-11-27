import type { ServerResponse } from 'node:http';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../config/env.config';
import type { OriginSecretSource } from '../config/origin-secret.provider';
import { AppModule } from './app.module';
import { ResultExceptionFilter } from './filters/result-exception.filter';
import { JsonLogger } from './logging/json-logger';
import { OriginGuardMiddleware } from './middleware/origin-guard.middleware';
import { RequestIdMiddleware, type RequestWithId } from './middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './middleware/request-logger.middleware';

export const GLOBAL_PREFIX = 'api/v1';

export interface CreateAppDeps {
  config: AppConfig;
  // Already loaded (`load()` completed) so the origin guard can read it synchronously.
  originSecret: OriginSecretSource;
  logger?: JsonLogger;
}

// Shared by main.ts and lambda.ts. Returns the initialized app; the caller decides whether to listen.
export async function createApp(deps: CreateAppDeps): Promise<INestApplication> {
  const logger = deps.logger ?? new JsonLogger();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ config: deps.config, originSecret: deps.originSecret, logger }),
    { logger: false },
  );

  // Mounted on the Express instance before init so every path runs them once, in this order:
  // request id first (the logger and guard read it), then the logger, then the origin guard.
  // Routes outside the global prefix (including "/") pass through them too.
  const requestId = app.get(RequestIdMiddleware);
  const requestLogger = app.get(RequestLoggerMiddleware);
  const originGuard = app.get(OriginGuardMiddleware);
  app.use((req: RequestWithId, res: ServerResponse, next: () => void) =>
    requestId.use(req, res, next),
  );
  app.use((req: RequestWithId, res: ServerResponse, next: () => void) =>
    requestLogger.use(req, res, next),
  );
  app.use((req: RequestWithId, res: ServerResponse, next: () => void) =>
    originGuard.use(req, res, next),
  );

  app.disable('x-powered-by');
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalFilters(new ResultExceptionFilter(logger));
  await app.init();
  return app;
}
