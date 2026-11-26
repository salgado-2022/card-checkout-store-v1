import jestConfig from '../../jest.config';

const EXPECTED_EXCLUSIONS = [
  '/src/main\\.ts$',
  '/src/lambda\\.ts$',
  '\\.module\\.ts$',
  '\\.d\\.ts$',
  '/scripts/seed\\.ts$',
];

describe('api Jest configuration (task 2.3)', () => {
  it('uses ts-jest for TypeScript files', () => {
    expect(jestConfig.transform).toEqual({
      '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    });
  });

  it('sets the 80% global coverage threshold for the four metrics', () => {
    expect(jestConfig.coverageThreshold).toEqual({
      global: { statements: 80, branches: 80, functions: 80, lines: 80 },
    });
  });

  it('collects coverage from every file under src/', () => {
    expect(jestConfig.collectCoverageFrom).toEqual(['<rootDir>/src/**/*.ts']);
  });

  it('excludes exactly the allowed files from coverage', () => {
    expect(jestConfig.coveragePathIgnorePatterns).toEqual(EXPECTED_EXCLUSIONS);
  });

  it('discovers tests both in test/ and co-located in src/', () => {
    expect(jestConfig.roots).toEqual(['<rootDir>/src', '<rootDir>/test']);
  });
});
