import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';

const apiRoot = resolve(__dirname, '..');
const tscBin = resolve(apiRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const buildDir = resolve(apiRoot, 'build');

// Optional NestJS packages the API does not use. Nest loads them lazily, only when needed.
export const EXTERNAL_PACKAGES: readonly string[] = [
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  // @nestjs/mapped-types first requires class-transformer/cjs/storage (bundled); class-transformer/storage is only its legacy fallback in the catch branch and never runs with class-transformer 0.5.
  'class-transformer/storage',
];

// NestJS `ValidationPipe` requires these lazily. Until the DTO tasks install them, esbuild cannot
// resolve them, so they are external only while missing. Once installed they are bundled.
const LAZY_VALIDATION_PACKAGES: readonly string[] = ['class-validator', 'class-transformer'];

function isInstalled(packageName: string): boolean {
  try {
    require.resolve(packageName, { paths: [apiRoot] });
    return true;
  } catch {
    return false;
  }
}

// Step 1 emits JavaScript with decorator metadata. Step 2 bundles that JavaScript. esbuild alone
// does not implement `emitDecoratorMetadata`, so it must never read the `.ts` sources.
export function buildLambda(outDir: string = resolve(apiRoot, 'dist')): string {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });

  const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
    cwd: apiRoot,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    throw new Error(`tsc failed with exit code ${String(tsc.status)}`);
  }

  const outfile = resolve(outDir, 'lambda.js');
  buildSync({
    entryPoints: [resolve(buildDir, 'lambda.js')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    external: [
      ...EXTERNAL_PACKAGES,
      ...LAZY_VALIDATION_PACKAGES.filter((name) => !isInstalled(name)),
    ],
    logLevel: 'warning',
  });
  return outfile;
}

if (require.main === module) {
  const outDir = process.argv[2] ?? process.env.LAMBDA_OUT_DIR;
  const outfile = buildLambda(outDir === undefined ? undefined : resolve(outDir));
  process.stdout.write(`Lambda bundle written to ${outfile}\n`);
}
