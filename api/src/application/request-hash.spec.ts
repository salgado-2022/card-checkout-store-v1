import { canonicalJson, requestHash } from './request-hash';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    const value = { b: { d: 1, c: { z: true, y: null } }, a: 'x' };
    expect(canonicalJson(value)).toBe('{"a":"x","b":{"c":{"y":null,"z":true},"d":1}}');
  });

  it('produces the same text for objects that differ only in key order', () => {
    const first = {
      productId: 'p1',
      quantity: 2,
      delivery: { city: 'Bogotá', postalCode: '110111' },
    };
    const second = {
      delivery: { postalCode: '110111', city: 'Bogotá' },
      quantity: 2,
      productId: 'p1',
    };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('keeps array order, so a different order gives a different text', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('sorts keys inside objects that sit inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('serializes strings, numbers, booleans and null with JSON escaping', () => {
    expect(canonicalJson('quote " and \\ slash')).toBe('"quote \\" and \\\\ slash"');
    expect(canonicalJson(251_000)).toBe('251000');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
  });

  it('serializes empty object and empty array', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

describe('requestHash', () => {
  // Computed outside the code with:
  // printf '%s' '{"a":"x","b":{"c":[2,1],"d":1}}' | shasum -a 256
  const knownVectorHex = '9485795dd2e31a4134702cc8889e292fa1f69e268326c2988ca687fbc981ea48';

  it('matches the known vector for a fixed body', () => {
    expect(requestHash({ b: { d: 1, c: [2, 1] }, a: 'x' })).toBe(knownVectorHex);
  });

  it('is the same for bodies that differ only in key order at several depths', () => {
    const first = {
      productId: 'prod_test_0001',
      quantity: 1,
      payment: { installments: 3, brand: 'VISA', lastFour: '4242' },
      delivery: { address: { line1: 'Calle test 1', city: 'Bogotá' }, recipientName: 'Ana Test' },
    };
    const second = {
      delivery: { recipientName: 'Ana Test', address: { city: 'Bogotá', line1: 'Calle test 1' } },
      payment: { lastFour: '4242', brand: 'VISA', installments: 3 },
      quantity: 1,
      productId: 'prod_test_0001',
    };
    expect(requestHash(first)).toBe(requestHash(second));
  });

  it('differs when the order of array items differs', () => {
    expect(requestHash({ items: [1, 2] })).not.toBe(requestHash({ items: [2, 1] }));
  });

  it('differs when a value differs', () => {
    expect(requestHash({ quantity: 1 })).not.toBe(requestHash({ quantity: 2 }));
    expect(requestHash({ quantity: 1 })).not.toBe(requestHash({ quantity: '1' }));
  });

  it('differs when a key is added', () => {
    expect(requestHash({ quantity: 1 })).not.toBe(requestHash({ quantity: 1, extra: null }));
  });

  it('returns a lowercase 64-character hex digest', () => {
    expect(requestHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
