import { computeIntegritySignature } from './integrity-signature';

describe('computeIntegritySignature', () => {
  const testReference = 'ORD-TEST-0001';
  const testAmountInCents = 251_000;
  const testCurrency = 'COP';
  const testIntegrityValue = 'integrity_test_fake';
  // Computed outside the code with:
  // printf '%s' 'ORD-TEST-0001251000COPintegrity_test_fake' | shasum -a 256
  const knownVectorHex = 'd2e99491d577bcea4f158615ebb2f495e57110d78e42c028755f27c124d39bd5';

  it('matches the known vector for a fixed reference, amount, currency and secret', () => {
    expect(
      computeIntegritySignature(testReference, testAmountInCents, testCurrency, testIntegrityValue),
    ).toBe(knownVectorHex);
  });

  it('returns a lowercase 64-character hex digest', () => {
    const signature = computeIntegritySignature(
      testReference,
      testAmountInCents,
      testCurrency,
      testIntegrityValue,
    );
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const first = computeIntegritySignature(
      testReference,
      testAmountInCents,
      testCurrency,
      testIntegrityValue,
    );
    const second = computeIntegritySignature(
      testReference,
      testAmountInCents,
      testCurrency,
      testIntegrityValue,
    );
    expect(second).toBe(first);
  });

  it('changes when the reference changes', () => {
    expect(
      computeIntegritySignature(
        'ORD-TEST-0002',
        testAmountInCents,
        testCurrency,
        testIntegrityValue,
      ),
    ).not.toBe(knownVectorHex);
  });

  it('changes when the amount changes by one cent', () => {
    expect(
      computeIntegritySignature(
        testReference,
        testAmountInCents + 1,
        testCurrency,
        testIntegrityValue,
      ),
    ).not.toBe(knownVectorHex);
  });

  it('changes when the currency changes', () => {
    expect(
      computeIntegritySignature(testReference, testAmountInCents, 'USD', testIntegrityValue),
    ).not.toBe(knownVectorHex);
  });

  it('changes when the integrity value changes', () => {
    expect(
      computeIntegritySignature(
        testReference,
        testAmountInCents,
        testCurrency,
        'integrity_test_fakf',
      ),
    ).not.toBe(knownVectorHex);
  });
});
