import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { err, ok, ResultAsync, type Result } from 'neverthrow';
import type { AppConfig } from './env.config';

// Injection token for Nest: `{ provide: ORIGIN_SECRET_PROVIDER, useFactory: ... }`.
export const ORIGIN_SECRET_PROVIDER = Symbol('ORIGIN_SECRET_PROVIDER');

// Carries the parameter name and the error class name only. The secret value never appears here.
export interface OriginSecretError {
  readonly kind: 'ORIGIN_SECRET_UNAVAILABLE' | 'ORIGIN_SECRET_NOT_LOADED';
  readonly parameterName: string;
  readonly reason: string;
}

// Port-like contract so consumers (the origin guard) can be stubbed in tests.
export interface OriginSecretSource {
  load(): ResultAsync<string, OriginSecretError>;
  get(): Result<string, OriginSecretError>;
}

// Module-level state survives across invocations of the same Lambda container.
const resolvedSecrets = new Map<string, string>();
const inFlightReads = new Map<string, Promise<string>>();

export function resetOriginSecretCacheForTests(): void {
  resolvedSecrets.clear();
  inFlightReads.clear();
}

export function describeOriginSecretError(error: OriginSecretError): string {
  return `${error.kind}: parameter "${error.parameterName}" (${error.reason})`;
}

async function readParameter(client: SSMClient, parameterName: string): Promise<string> {
  const output = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  const value = output.Parameter?.Value;
  if (value === undefined || value === '') {
    throw new EmptyParameterError();
  }
  return value;
}

class EmptyParameterError extends Error {
  constructor() {
    super('EmptyParameter');
    this.name = 'EmptyParameter';
  }
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.name : 'UnknownError');

export class OriginSecretProvider implements OriginSecretSource {
  private client: SSMClient | undefined;

  constructor(
    private readonly parameterName: string,
    client?: SSMClient,
  ) {
    this.client = client;
  }

  load(): ResultAsync<string, OriginSecretError> {
    const cached = resolvedSecrets.get(this.parameterName);
    if (cached !== undefined) {
      return ResultAsync.fromSafePromise(Promise.resolve(cached));
    }
    let pending = inFlightReads.get(this.parameterName);
    if (pending === undefined) {
      const parameterName = this.parameterName;
      pending = readParameter((this.client ??= new SSMClient({})), parameterName)
        .then((value) => {
          resolvedSecrets.set(parameterName, value);
          return value;
        })
        .finally(() => {
          inFlightReads.delete(parameterName);
        });
      inFlightReads.set(parameterName, pending);
    }
    return ResultAsync.fromPromise(pending, (cause): OriginSecretError => ({
      kind: 'ORIGIN_SECRET_UNAVAILABLE',
      parameterName: this.parameterName,
      reason: reasonOf(cause),
    }));
  }

  get(): Result<string, OriginSecretError> {
    const cached = resolvedSecrets.get(this.parameterName);
    if (cached === undefined) {
      return err({
        kind: 'ORIGIN_SECRET_NOT_LOADED',
        parameterName: this.parameterName,
        reason: 'load() has not completed',
      });
    }
    return ok(cached);
  }
}

export const createOriginSecretProvider = (
  config: Pick<AppConfig, 'originVerifySecretParam'>,
  client?: SSMClient,
): OriginSecretProvider => new OriginSecretProvider(config.originVerifySecretParam, client);
