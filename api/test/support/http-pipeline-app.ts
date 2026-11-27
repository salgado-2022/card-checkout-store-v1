import type { ServerResponse } from 'node:http';
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok } from 'neverthrow';
import type { OriginSecretSource } from '../../src/infrastructure/config/origin-secret.provider';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import {
  JsonLogger,
  type LogFields,
  type LogOutput,
} from '../../src/infrastructure/http/logging/json-logger';
import { preserveBodyParseFailure } from '../../src/infrastructure/http/middleware/body-parser-error.middleware';
import { contentTypeGuardMiddleware } from '../../src/infrastructure/http/middleware/content-type-guard.middleware';
import {
  OriginGuardMiddleware,
  type OriginGuardLogger,
} from '../../src/infrastructure/http/middleware/origin-guard.middleware';
import {
  RequestIdMiddleware,
  type RequestWithId,
} from '../../src/infrastructure/http/middleware/request-id.middleware';
import { createValidationPipe } from '../../src/infrastructure/http/validation-pipe';

// Fake value only. Tests send it as the X-Origin-Verify header.
export const TEST_ORIGIN_SECRET = 'fake-origin-secret-value-123';

export interface CapturedLogger {
  readonly logger: JsonLogger;
  readonly lines: string[];
}

// Collects every JSON log line written to stdout or stderr.
export function capturingLogger(): CapturedLogger {
  const lines: string[] = [];
  const output: LogOutput = {
    write: (chunk: string): boolean => {
      lines.push(chunk);
      return true;
    },
  };
  return { logger: new JsonLogger({ stdout: output, stderr: output }), lines };
}

export interface HttpPipelineAppOptions {
  readonly controllers: Type<unknown>[];
  readonly logger?: JsonLogger;
}

// Mounts the same middleware order as createApp (request id, origin guard, media-type guard,
// JSON body parser, prefix, validation pipe, exception filter) around test-only controllers.
export async function createHttpPipelineApp(
  options: HttpPipelineAppOptions,
): Promise<INestApplication> {
  @Module({ controllers: options.controllers })
  class PipelineTestModule {}

  const logger = options.logger ?? capturingLogger().logger;
  const secret: OriginSecretSource = { load: jest.fn(), get: () => ok(TEST_ORIGIN_SECRET) };
  const requestId = new RequestIdMiddleware();
  // The origin guard only passes primitive fields, so the JSON logger can serve as its sink.
  const originLogger: OriginGuardLogger = {
    warn: (message, fields) => logger.warn(message, fields as LogFields),
    error: (message, fields) => logger.error(message, fields as LogFields),
  };
  const originGuard = new OriginGuardMiddleware(secret, originLogger);

  const app = await NestFactory.create<NestExpressApplication>(PipelineTestModule, {
    logger: false,
  });
  app.use((req: RequestWithId, res: ServerResponse, next: () => void) =>
    requestId.use(req, res, next),
  );
  app.use((req: RequestWithId, res: ServerResponse, next: () => void) =>
    originGuard.use(req, res, next),
  );
  app.use(contentTypeGuardMiddleware);
  app.useBodyParser('json');
  app.use(preserveBodyParseFailure);
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(logger));
  await app.init();
  return app;
}
