import { UlidIdGenerator } from './ulid-id-generator';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('UlidIdGenerator', () => {
  it('returns a 26-character ULID in Crockford base32', () => {
    const id = new UlidIdGenerator().ulid();

    expect(id).toMatch(ULID_PATTERN);
  });

  it('returns unique ids across a burst of calls', () => {
    const generator = new UlidIdGenerator();
    const ids = Array.from({ length: 1000 }, () => generator.ulid());

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns ids that sort in generation order, even within the same millisecond', () => {
    const generator = new UlidIdGenerator();
    const ids = Array.from({ length: 1000 }, () => generator.ulid());

    expect([...ids].sort()).toEqual(ids);
  });

  it('encodes the current time in the first 10 characters', () => {
    const before = Date.now();
    const id = new UlidIdGenerator().ulid();
    const after = Date.now();

    const timestamp = decodeTimestamp(id.slice(0, 10));

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

function decodeTimestamp(encoded: string): number {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return [...encoded].reduce((acc, char) => acc * 32 + alphabet.indexOf(char), 0);
}
