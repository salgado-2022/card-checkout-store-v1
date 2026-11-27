import { monotonicFactory } from 'ulid';
import type { IdGenerator } from '../../application/ports/id-generator';

// A monotonic factory keeps ids generated within the same millisecond in increasing order,
// so ids sort by creation time even under bursts.
export class UlidIdGenerator implements IdGenerator {
  private readonly nextUlid = monotonicFactory();

  ulid(): string {
    return this.nextUlid();
  }
}
