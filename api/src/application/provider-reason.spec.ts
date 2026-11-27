import { MAX_PROVIDER_REASON_LENGTH, providerReason } from './provider-reason';

describe('providerReason', () => {
  it.each([null, undefined, '', '   ', '\n\t\u0000', ' \u2028 '])(
    'omits the reason for %j',
    (message) => {
      expect(providerReason(message)).toBeUndefined();
    },
  );

  it('trims the message', () => {
    expect(providerReason('  Fondos insuficientes  ')).toBe('Fondos insuficientes');
  });

  it('removes control characters and line separators', () => {
    expect(providerReason('Insufficient\u0000 funds\r\n\u0007\u2029!')).toBe('Insufficient funds!');
  });

  it('removes format characters such as bidi overrides and zero-width spaces', () => {
    expect(providerReason('Fondos\u200B insuficientes\u202E\uFEFF')).toBe('Fondos insuficientes');
  });

  it('keeps accents and symbols', () => {
    expect(providerReason('Tarjeta rechazada: señal №1')).toBe('Tarjeta rechazada: señal №1');
  });

  it('cuts to 200 characters', () => {
    const reason = providerReason('a'.repeat(500));
    expect(reason).toHaveLength(MAX_PROVIDER_REASON_LENGTH);
  });

  it('keeps a message of exactly 200 characters', () => {
    expect(providerReason('b'.repeat(200))).toBe('b'.repeat(200));
  });

  it('never splits a surrogate pair when cutting', () => {
    const reason = providerReason('😀'.repeat(300)) as string;
    expect(Array.from(reason)).toHaveLength(200);
    expect(reason).toBe('😀'.repeat(200));
  });

  it('trims again after cutting', () => {
    expect(providerReason(`${'c'.repeat(199)} tail`)).toBe('c'.repeat(199));
  });
});
