import { getEnv } from './env';

type ViteEnvGlobal = { __VITE_ENV__?: Record<string, string> };

// The Jest transformer rewrites `import.meta.env` to this global (see jest/transform-import-meta.ts).
function setViteEnv(values: Record<string, string> | undefined): void {
  (globalThis as ViteEnvGlobal).__VITE_ENV__ = values;
}

describe('getEnv', () => {
  afterEach(() => {
    setViteEnv(undefined);
  });

  it('returns the value of a public variable from the given source', () => {
    const source = { VITE_API_BASE: '/api/v1' };

    expect(getEnv('VITE_API_BASE', source)).toBe('/api/v1');
  });

  it('returns undefined when the variable is not set in the source', () => {
    expect(getEnv('VITE_PAYMENT_PUBLIC_KEY', {})).toBeUndefined();
  });

  it('reads the Vite environment by default', () => {
    setViteEnv({ VITE_PAYMENT_PUBLIC_KEY: 'pub_test_fake' });

    expect(getEnv('VITE_PAYMENT_PUBLIC_KEY')).toBe('pub_test_fake');
  });

  it.each([
    ['VITE_API_BASE', '/api/v1'],
    ['VITE_PAYMENT_API_URL', 'https://payment.example.test'],
    ['VITE_PAYMENT_PUBLIC_KEY', 'pub_test_fake'],
  ] as const)('reads %s by name from the Vite environment by default', (name, value) => {
    setViteEnv({ [name]: value });
    expect(getEnv(name)).toBe(value);
  });

  it('returns undefined by default when no Vite environment is available', () => {
    expect(getEnv('VITE_API_BASE')).toBeUndefined();
  });
});
