import * as fc from 'fast-check';
import { canonicalJson, requestHash, type JsonValue } from './request-hash';

const NUM_RUNS = 100;

/**
 * Pairs a JSON value with a copy whose object keys are permuted at every depth. Array order is
 * kept, because array order is part of the request.
 */
function withShuffledKeys(value: JsonValue): fc.Arbitrary<JsonValue> {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return fc.constant<JsonValue>([]);
    }
    return fc.tuple(...value.map(withShuffledKeys)).map((items): JsonValue => items);
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return fc.constant<JsonValue>({});
    }
    return fc
      .shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length })
      .chain((order) =>
        fc
          .tuple(...order.map((key) => withShuffledKeys(value[key] as JsonValue)))
          .map((children): JsonValue =>
            Object.fromEntries(order.map((key, index) => [key, children[index]])),
          ),
      );
  }
  return fc.constant(value);
}

const jsonWithPermutedKeysArbitrary = fc
  .jsonValue()
  .map((value) => value as JsonValue)
  .chain((original) => withShuffledKeys(original).map((permuted) => ({ original, permuted })));

// Feature: payments-api, Property 22: Request-hash canonicalization is key-order independent
describe('Feature: payments-api, Property 22: Request-hash canonicalization is key-order independent', () => {
  it('gives the same canonical text and the same Request_Hash for any key permutation at every depth', () => {
    fc.assert(
      fc.property(jsonWithPermutedKeysArbitrary, ({ original, permuted }) => {
        expect(canonicalJson(permuted)).toBe(canonicalJson(original));
        expect(requestHash(permuted)).toBe(requestHash(original));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
