import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON_PATH = path.resolve(__dirname, '../../package.json');

const REQUIRED_DEPENDENCIES: readonly string[] = [
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/lib-dynamodb',
  '@nestjs/throttler',
  '@nestjs/swagger',
  'class-validator',
  'class-transformer',
  'ulid',
];

const REQUIRED_DEV_DEPENDENCIES: readonly string[] = ['swagger-ui-dist'];

const HTTP_MOCKING_LIBRARIES: readonly string[] = ['nock', 'msw'];

const FORBIDDEN_TEST_RUNNERS: readonly string[] = ['vitest', 'mocha'];

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(): PackageManifest {
  const raw: unknown = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  return raw as PackageManifest;
}

describe('api/package.json declared dependencies', () => {
  const manifest = readManifest();
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};

  it.each(REQUIRED_DEPENDENCIES)('declares %s under dependencies', (name) => {
    expect(dependencies).toHaveProperty([name]);
    expect(devDependencies).not.toHaveProperty([name]);
  });

  it.each(REQUIRED_DEV_DEPENDENCIES)('declares %s under devDependencies', (name) => {
    expect(devDependencies).toHaveProperty([name]);
    expect(dependencies).not.toHaveProperty([name]);
  });

  it('declares nock or msw under devDependencies', () => {
    const declared = HTTP_MOCKING_LIBRARIES.filter((name) =>
      Object.prototype.hasOwnProperty.call(devDependencies, name),
    );
    expect(declared.length).toBeGreaterThanOrEqual(1);
  });

  it('does not declare vitest or mocha', () => {
    const allNames = [...Object.keys(dependencies), ...Object.keys(devDependencies)];
    for (const forbidden of FORBIDDEN_TEST_RUNNERS) {
      expect(allNames).not.toContain(forbidden);
    }
  });

  it('keeps the existing NestJS 11 runtime packages', () => {
    expect(dependencies).toHaveProperty(['@nestjs/common']);
    expect(dependencies).toHaveProperty(['@nestjs/core']);
    expect(dependencies).toHaveProperty(['@nestjs/platform-express']);
  });
});
