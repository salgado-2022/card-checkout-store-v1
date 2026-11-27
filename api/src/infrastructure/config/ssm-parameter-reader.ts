import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ResultAsync } from 'neverthrow';

// Reads SecureString parameters from SSM once per cold start. The cache lives at module scope and is
// keyed by parameter name, so every reader in the same Lambda container shares it.
// Failures are not cached. Errors carry the parameter name and an exception class name only: the
// value never appears in an error, a log line or a thrown message.

export interface SsmParameterError {
  readonly kind: 'SSM_PARAMETER_UNAVAILABLE';
  readonly parameterName: string;
  readonly reason: string;
}

const resolvedValues = new Map<string, string>();
const inFlightReads = new Map<string, Promise<string>>();

class EmptyParameterError extends Error {
  constructor() {
    super('EmptyParameter');
    this.name = 'EmptyParameter';
  }
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.name : 'UnknownError');

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

export class SsmParameterReader {
  private client: SSMClient | undefined;

  constructor(client?: SSMClient) {
    this.client = client;
  }

  /** Resolves the decrypted value. Concurrent callers share one SSM request. */
  load(parameterName: string): ResultAsync<string, SsmParameterError> {
    const cached = resolvedValues.get(parameterName);
    if (cached !== undefined) {
      return ResultAsync.fromSafePromise(Promise.resolve(cached));
    }
    let pending = inFlightReads.get(parameterName);
    if (pending === undefined) {
      pending = readParameter((this.client ??= new SSMClient({})), parameterName)
        .then((value) => {
          resolvedValues.set(parameterName, value);
          return value;
        })
        .finally(() => {
          inFlightReads.delete(parameterName);
        });
      inFlightReads.set(parameterName, pending);
    }
    return ResultAsync.fromPromise(pending, (cause): SsmParameterError => ({
      kind: 'SSM_PARAMETER_UNAVAILABLE',
      parameterName,
      reason: reasonOf(cause),
    }));
  }

  /** Synchronous read of a value already loaded into the module cache. */
  peek(parameterName: string): string | undefined {
    return resolvedValues.get(parameterName);
  }
}

export function resetSsmParameterCacheForTests(): void {
  resolvedValues.clear();
  inFlightReads.clear();
}
