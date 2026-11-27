import { type DynamicModule, Module } from '@nestjs/common';
import { type AppConfig } from '../config/env.config';
import { ORIGIN_SECRET_PROVIDER, type OriginSecretSource } from '../config/origin-secret.provider';
import { HealthController } from './controllers/health.controller';
import { JsonLogger } from './logging/json-logger';
import { OriginGuardMiddleware } from './middleware/origin-guard.middleware';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './middleware/request-logger.middleware';

export const APP_CONFIG = Symbol('APP_CONFIG');

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
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: ORIGIN_SECRET_PROVIDER, useValue: options.originSecret },
        { provide: JsonLogger, useValue: options.logger },
        RequestIdMiddleware,
        RequestLoggerMiddleware,
        OriginGuardMiddleware,
      ],
    };
  }
}
