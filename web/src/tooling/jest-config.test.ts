import config from '../../jest.config';
import transformer, { rewriteImportMetaEnv } from '../../jest/transform-import-meta';

// Built from parts so this file's own text is not rewritten by the transformer it tests.
const IMPORT_META_ENV = ['import', '.meta', '.env'].join('');

describe('import.meta.env transformer', () => {
  it('rewrites import.meta.env to the Jest global with an empty fallback', () => {
    expect(rewriteImportMetaEnv(`const env = ${IMPORT_META_ENV};`)).toBe(
      'const env = (globalThis.__VITE_ENV__ ?? {});',
    );
  });

  it('leaves source without import.meta.env unchanged', () => {
    const source = 'export const value = 1;';

    expect(rewriteImportMetaEnv(source)).toBe(source);
  });

  it('exposes the process and getCacheKey functions of a Jest transformer', () => {
    expect(typeof transformer.process).toBe('function');
    expect(typeof transformer.getCacheKey).toBe('function');
  });
});

describe('web Jest configuration', () => {
  it('sets the 80% global coverage threshold for all four metrics', () => {
    expect(config.coverageThreshold).toEqual({
      global: { statements: 80, branches: 80, functions: 80, lines: 80 },
    });
  });

  it('collects coverage from every TypeScript file under src', () => {
    expect(config.collectCoverageFrom).toEqual(['<rootDir>/src/**/*.{ts,tsx}']);
  });

  it('excludes only the entry points and type-only files from coverage', () => {
    expect(config.coveragePathIgnorePatterns).toEqual([
      '<rootDir>/src/app/main\\.tsx$',
      '<rootDir>/src/index\\.tsx$',
      '\\.d\\.ts$',
    ]);
  });

  it('runs in jsdom and maps CSS Modules to identity-obj-proxy', () => {
    expect(config.testEnvironment).toBe('jsdom');
    expect(config.moduleNameMapper).toEqual({
      '\\.module\\.(css|scss)$': 'identity-obj-proxy',
    });
  });
});
