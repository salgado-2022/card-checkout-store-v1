import type { SSMClient } from '@aws-sdk/client-ssm';
import { err, ok, ResultAsync, type Result } from 'neverthrow';
import type { AppConfig } from './env.config';
import { resetSsmParameterCacheForTests, SsmParameterReader } from './ssm-parameter-reader';
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
export function resetOriginSecretCacheForTests(): void {
  resetSsmParameterCacheForTests();
}
export function describeOriginSecretError(error: OriginSecretError): string {
  return `${error.kind}: parameter "${error.parameterName}" (${error.reason})`;
}
export class OriginSecretProvider implements OriginSecretSource {
  private readonly reader: SsmParameterReader;

  constructor(
    private readonly parameterName: string,
    client?: SSMClient,
  ) {
    this.reader = new SsmParameterReader(client);
  }

  load(): ResultAsync<string, OriginSecretError> {
    return this.reader.load(this.parameterName).mapErr((cause): OriginSecretError => ({
      kind: 'ORIGIN_SECRET_UNAVAILABLE',
      parameterName: cause.parameterName,
      reason: cause.reason,
    }));
  }

  get(): Result<string, OriginSecretError> {
    const cached = this.reader.peek(this.parameterName);
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
