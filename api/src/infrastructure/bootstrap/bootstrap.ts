import type { INestApplication } from '@nestjs/common';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { errAsync, ResultAsync, type Result } from 'neverthrow';
import serverlessHttp from 'serverless-http';
import type { AppConfig, ConfigError } from '../config/env.config';
import {
  describeOriginSecretError,
  type OriginSecretError,
  type OriginSecretSource,
} from '../config/origin-secret.provider';
import type { CreateAppDeps } from '../http/create-app';

export type LambdaHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

// `message` names the variable or parameter only. Values and secrets never reach it.
export interface BootstrapError {
  readonly kind: 'INVALID_CONFIG' | 'ORIGIN_SECRET_UNAVAILABLE' | 'APP_CREATION_FAILED';
  readonly message: string;
}

export interface PrepareAppDeps {
  loadConfig: () => Result<AppConfig, ConfigError>;
  createSecretProvider: (config: AppConfig) => OriginSecretSource;
  createApp: (deps: CreateAppDeps) => Promise<INestApplication>;
}

export interface InitServerDeps extends PrepareAppDeps {
  adapt: (app: INestApplication) => LambdaHandler;
}

const configFailure = (error: ConfigError): BootstrapError => ({
  kind: 'INVALID_CONFIG',
  message: `Invalid configuration: ${error.variableName}`,
});

const secretFailure = (error: OriginSecretError): BootstrapError => ({
  kind: 'ORIGIN_SECRET_UNAVAILABLE',
  message: describeOriginSecretError(error),
});

// Only the error class name is kept: the original message could echo a configured value.
const appFailure = (cause: unknown): BootstrapError => ({
  kind: 'APP_CREATION_FAILED',
  message: `Application creation failed (${cause instanceof Error ? cause.name : 'UnknownError'})`,
});

// Loads config, then the origin secret, and only then builds the initialized (not listening) app.
export function prepareApp(deps: PrepareAppDeps): ResultAsync<INestApplication, BootstrapError> {
  const configResult = deps.loadConfig();
  if (configResult.isErr()) {
    return errAsync(configFailure(configResult.error));
  }
  const config = configResult.value;
  const originSecret = deps.createSecretProvider(config);
  return originSecret
    .load()
    .mapErr(secretFailure)
    .andThen(() => ResultAsync.fromPromise(deps.createApp({ config, originSecret }), appFailure));
}

export function initServer(deps: InitServerDeps): ResultAsync<LambdaHandler, BootstrapError> {
  return prepareApp(deps).andThen((app) =>
    ResultAsync.fromPromise(
      Promise.resolve().then(() => deps.adapt(app)),
      appFailure,
    ),
  );
}

// Wraps the Express instance behind Nest for Lambda Function URL (payload v2) events.
export function adaptNestApp(app: INestApplication): LambdaHandler {
  const instance = app.getHttpAdapter().getInstance() as Parameters<typeof serverlessHttp>[0];
  return serverlessHttp(instance) as unknown as LambdaHandler;
}

// One initialization per container. Concurrent callers share the in-flight promise and a
// success is kept forever. A failure is dropped so the next invocation retries, because the
// cause (for example a transient SSM error) may be gone by then.
export function createInitCache<T, E>(init: () => ResultAsync<T, E>): () => Promise<Result<T, E>> {
  let pending: Promise<Result<T, E>> | undefined;
  return () => {
    if (pending === undefined) {
      const attempt = Promise.resolve()
        .then(() => init())
        .then(
          (result) => {
            if (result.isErr() && pending === attempt) {
              pending = undefined;
            }
            return result;
          },
          (cause: unknown) => {
            if (pending === attempt) {
              pending = undefined;
            }
            throw cause;
          },
        );
      pending = attempt;
    }
    return pending;
  };
}
