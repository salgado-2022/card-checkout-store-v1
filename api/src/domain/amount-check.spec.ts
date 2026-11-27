import { checkAmount } from './amount-check';

const STORED = { totalInCents: 25_100_000, currency: 'COP', reference: 'ORD-STORED-0001' };
const REPORTED = { amountInCents: 25_100_000, currency: 'COP', reference: 'ORD-STORED-0001' };

describe('checkAmount', () => {
  it('returns match when the three fields are equal', () => {
    expect(checkAmount(REPORTED, STORED)).toEqual({ kind: 'match' });
  });

  it('names only amountInCents when the amount differs by one cent', () => {
    expect(checkAmount({ ...REPORTED, amountInCents: 25_100_001 }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['amountInCents'],
    });
  });

  it('names only currency when it differs', () => {
    expect(checkAmount({ ...REPORTED, currency: 'USD' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['currency'],
    });
  });

  it('treats a currency that differs only in letter case as a mismatch', () => {
    expect(checkAmount({ ...REPORTED, currency: 'cop' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['currency'],
    });
  });

  it('names only reference when it differs', () => {
    expect(checkAmount({ ...REPORTED, reference: 'ORD-OTHER-0002' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['reference'],
    });
  });

  it('lists amountInCents and currency in the fixed order', () => {
    expect(checkAmount({ ...REPORTED, amountInCents: 1, currency: 'USD' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['amountInCents', 'currency'],
    });
  });

  it('lists amountInCents and reference in the fixed order', () => {
    expect(checkAmount({ ...REPORTED, amountInCents: 1, reference: 'ORD-X' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['amountInCents', 'reference'],
    });
  });

  it('lists currency and reference in the fixed order', () => {
    expect(checkAmount({ ...REPORTED, currency: 'USD', reference: 'ORD-X' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['currency', 'reference'],
    });
  });

  it('lists all three fields in the fixed order', () => {
    expect(checkAmount({ amountInCents: 1, currency: 'USD', reference: 'ORD-X' }, STORED)).toEqual({
      kind: 'mismatch',
      fields: ['amountInCents', 'currency', 'reference'],
    });
  });
});
