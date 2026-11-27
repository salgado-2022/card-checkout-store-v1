import { createHash } from 'node:crypto';
import * as fc from 'fast-check';
import { computeIntegritySignature } from './integrity-signature';

const NUM_RUNS = 100;

const referenceArbitrary = fc.oneof(
  fc.stringMatching(/^ORD-[0-9A-HJKMNP-TV-Z]{26}$/),
  fc.string({ maxLength: 60 }),
);
const amountArbitrary = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const currencyArbitrary = fc.oneof(fc.constant('COP'), fc.string({ maxLength: 5 }));
const secretArbitrary = fc.string({ minLength: 1, maxLength: 64 });

// Feature: payments-api, Property 23: Integrity signature and event checksum match their formulas (integrity signature part)
describe('Feature: payments-api, Property 23: Integrity signature and event checksum match their formulas (integrity signature part)', () => {
  it('equals the SHA-256 hex digest of reference, amount, currency and secret concatenated in that order', () => {
    fc.assert(
      fc.property(
        referenceArbitrary,
        amountArbitrary,
        currencyArbitrary,
        secretArbitrary,
        (reference, amountInCents, currency, secret) => {
          const independentDigest = createHash('sha256')
            .update(reference + String(amountInCents) + currency + secret, 'utf8')
            .digest('hex');

          expect(computeIntegritySignature(reference, amountInCents, currency, secret)).toBe(
            independentDigest,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
