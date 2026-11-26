import type { Config } from 'jest';

// Jest runs the suite as CommonJS, where `import.meta` is a syntax error. The transformer in
// `jest/transform-import-meta.ts` rewrites `import.meta.env` to `globalThis.__VITE_ENV__`, so
// `getEnv` in `src/shared/api/env.ts` runs unchanged. Tests set that global when they need values.
//
// Test files (`*.test.ts(x)`, `*.spec.ts(x)`) are not instrumented by Jest's coverage
// collection, so they do not count as source files. Node modules are outside `src/`, so
// `collectCoverageFrom` never reaches them and the default `/node_modules/` ignore is not needed.
//
// `src/index.tsx` and `src/app/main.tsx` are the only entry points excluded from coverage.
// Type-only files are excluded through `\.d\.ts$`.
const config: Config = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  // @swc/jest instead of ts-jest: no type-check step in the test run (tsc --noEmit covers that)
  // and no conflict with `verbatimModuleSyntax` in tsconfig.json.
  transform: {
    // Wraps @swc/jest and rewrites `import.meta.env` (see jest/transform-import-meta.ts).
    '^.+\\.(t|j)sx?$': '<rootDir>/jest/transform-import-meta.ts',
  },
  // msw 2.x and some of its dependencies ship only ESM. Jest runs CommonJS, so those packages go
  // through the same transformer. Every other node_modules package stays untransformed.
  transformIgnorePatterns: ['/node_modules/(?!(msw|rettime|until-async|tough-cookie)/)'],
  moduleNameMapper: {
    // CSS Modules return the class names as their own keys, so tests can query them.
    '\\.module\\.(css|scss)$': 'identity-obj-proxy',
  },
  setupFilesAfterEnv: ['<rootDir>/src/tooling/jest.setup.ts'],
  collectCoverageFrom: ['<rootDir>/src/**/*.{ts,tsx}'],
  coveragePathIgnorePatterns: [
    '<rootDir>/src/app/main\\.tsx$',
    '<rootDir>/src/index\\.tsx$',
    '\\.d\\.ts$',
  ],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
};

export default config;
