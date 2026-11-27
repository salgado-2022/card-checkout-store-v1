import { err, ok, type Result } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';
import type {
  BeginOutcome,
  IdempotencyRepository,
} from '../../src/application/ports/idempotency-repository';
import type { Clock } from '../../src/application/ports/clock';
import { notFound, respond } from './repository-result';

/** Equals the Lambda timeout: a record is stale only once its owner invocation can no longer run. */
export const STALE_AFTER_MS = 25_000;

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED';
  readonly createdAt: string;
  readonly transactionId: string | null;
  readonly statusCode?: number;
  readonly body?: unknown;
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  failure: RepositoryError | null = null;
  private readonly records = new Map<string, IdempotencyRecord>();

  /** Fresh versus stale is decided with this clock, never with the system clock. */
  constructor(private readonly clock: Clock) {}

  begin(key: string, requestHash: string, now: Date) {
    return respond(this.failure, () => ok(this.beginNow(key, requestHash, now)));
  }

  attachTransactionId(key: string, transactionId: string) {
    return respond(this.failure, () => this.patch(key, { transactionId }));
  }

  complete(key: string, statusCode: number, body: unknown) {
    return respond(this.failure, () => this.patch(key, { state: 'COMPLETED', statusCode, body }));
  }

  release(key: string) {
    return respond(this.failure, () => {
      this.records.delete(key);
      return ok(undefined);
    });
  }

  takeOver(key: string, previousCreatedAt: string) {
    return respond(this.failure, () => {
      const record = this.records.get(key);
      const stillTakeable =
        record !== undefined &&
        record.state === 'IN_PROGRESS' &&
        record.transactionId === null &&
        record.createdAt === previousCreatedAt;
      if (!stillTakeable) {
        return ok<'taken' | 'lost_race', RepositoryError>('lost_race');
      }
      this.records.set(key, { ...record, createdAt: this.clock.now().toISOString() });
      return ok<'taken' | 'lost_race', RepositoryError>('taken');
    });
  }

  /** Test helper: the stored record for `key`, if any. */
  get(key: string): Readonly<IdempotencyRecord> | undefined {
    return this.records.get(key);
  }

  private beginNow(key: string, requestHash: string, now: Date): BeginOutcome {
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, {
        requestHash,
        state: 'IN_PROGRESS',
        createdAt: now.toISOString(),
        transactionId: null,
      });
      return { kind: 'created' };
    }
    if (existing.requestHash !== requestHash) {
      return { kind: 'hash_mismatch' };
    }
    if (existing.state === 'COMPLETED') {
      return {
        kind: 'completed',
        statusCode: existing.statusCode ?? 0,
        body: existing.body,
      };
    }
    const ageInMs = this.clock.now().getTime() - new Date(existing.createdAt).getTime();
    if (ageInMs < STALE_AFTER_MS) {
      return { kind: 'in_progress_fresh' };
    }
    return {
      kind: 'in_progress_stale',
      transactionId: existing.transactionId,
      createdAt: existing.createdAt,
    };
  }

  private patch(key: string, fields: Partial<IdempotencyRecord>): Result<void, RepositoryError> {
    const record = this.records.get(key);
    if (!record) {
      return err(notFound('IdempotencyRecord'));
    }
    this.records.set(key, { ...record, ...fields });
    return ok(undefined);
  }
}
