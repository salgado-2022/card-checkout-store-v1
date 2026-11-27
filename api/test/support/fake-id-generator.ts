import type { IdGenerator } from '../../src/application/ports/id-generator';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_PART_LENGTH = 16;
const TIME_PART = '0'.repeat(10);

/**
 * Deterministic, ULID-shaped ids: 10 zero characters followed by a 16-character base32 counter.
 * The first character is `0`, so `ORD-<id>` is always a valid Reference.
 */
export class FakeIdGenerator implements IdGenerator {
  private counter = 0;

  ulid(): string {
    this.counter += 1;
    let remaining = this.counter;
    let encoded = '';
    while (encoded.length < RANDOM_PART_LENGTH) {
      encoded = `${CROCKFORD[remaining % 32]}${encoded}`;
      remaining = Math.floor(remaining / 32);
    }
    return `${TIME_PART}${encoded}`;
  }
}
