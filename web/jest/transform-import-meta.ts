import { createTransformer } from '@swc/jest';

// Jest runs the suite as CommonJS, where `import.meta` is a syntax error. Vite provides
// `import.meta.env` only in the bundle. This transformer rewrites `import.meta.env` to
// `globalThis.__VITE_ENV__` (or `{}` when that global is missing) before swc compiles the file,
// so source code keeps the Vite form. Tests set `globalThis.__VITE_ENV__` when they need values.
// Only the `import.meta.env` form is rewritten. Other `import.meta` uses still fail under Jest.
const IMPORT_META_ENV = /\bimport\.meta\.env\b/g;
const REPLACEMENT = '(globalThis.__VITE_ENV__ ?? {})';

// Minimal shape of the @swc/jest transformer that this file uses. The package ships loose types
// (optional methods, overloads), so the cast is limited to this one place.
interface SwcJestTransformer {
  process(source: string, filename: string, options: unknown): unknown;
  getCacheKey(...args: unknown[]): string;
}

const swcTransformer = createTransformer({
  jsc: {
    parser: { syntax: 'typescript', tsx: true },
    transform: { react: { runtime: 'automatic' } },
  },
  // package.json sets "type": "module", which would make @swc/jest emit ESM. Jest runs CJS.
  module: { type: 'commonjs' },
}) as unknown as SwcJestTransformer;

export function rewriteImportMetaEnv(source: string): string {
  return source.replace(IMPORT_META_ENV, REPLACEMENT);
}

export default {
  process(source: string, filename: string, options: unknown): unknown {
    return swcTransformer.process(rewriteImportMetaEnv(source), filename, options);
  },
  getCacheKey(...args: unknown[]): string {
    return swcTransformer.getCacheKey(...args);
  },
};
