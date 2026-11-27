import { timingSafeEqualStrings } from './timing-safe-equal';

describe('timingSafeEqualStrings', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualStrings('origin-secret-value', 'origin-secret-value')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqualStrings('origin-secret-value', 'origin-secret-valuf')).toBe(false);
  });

  it('returns false without throwing when the lengths differ', () => {
    expect(timingSafeEqualStrings('short', 'a much longer value')).toBe(false);
    expect(timingSafeEqualStrings('a much longer value', 'short')).toBe(false);
  });

  it('returns false when one string is a prefix of the other', () => {
    expect(timingSafeEqualStrings('secret', 'secret-extra')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });

  it('returns false when only one string is empty', () => {
    expect(timingSafeEqualStrings('', 'x')).toBe(false);
    expect(timingSafeEqualStrings('x', '')).toBe(false);
  });

  it('compares unicode strings by content', () => {
    expect(timingSafeEqualStrings('clave-ñandú-🔐', 'clave-ñandú-🔐')).toBe(true);
    expect(timingSafeEqualStrings('clave-ñandú-🔐', 'clave-nandu-🔐')).toBe(false);
    expect(timingSafeEqualStrings('🔐', '🔑')).toBe(false);
  });

  it('keeps distinct lone surrogates distinct', () => {
    expect(timingSafeEqualStrings('\uD800', '\uDFFF')).toBe(false);
    expect(timingSafeEqualStrings('\uD800', '\uD800')).toBe(true);
  });
});
