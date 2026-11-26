export type PublicEnvName = 'VITE_API_BASE' | 'VITE_PAYMENT_API_URL' | 'VITE_PAYMENT_PUBLIC_KEY';
export type EnvSource = Readonly<Partial<Record<PublicEnvName, string>>>;

// Reads one public `VITE_*` value by its name. Each variable is accessed explicitly so the full
// `import.meta.env` object is never passed around. Vite replaces these accesses at build time.
// Under Jest, the transformer in jest/transform-import-meta.ts rewrites them to a global.
function readViteEnv(name: PublicEnvName): string | undefined {
  switch (name) {
    case 'VITE_API_BASE':
      return import.meta.env.VITE_API_BASE;
    case 'VITE_PAYMENT_API_URL':
      return import.meta.env.VITE_PAYMENT_API_URL;
    case 'VITE_PAYMENT_PUBLIC_KEY':
      return import.meta.env.VITE_PAYMENT_PUBLIC_KEY;
  }
}

// Reads a public `VITE_*` value. Without a source, the value comes from Vite's environment. Tests
// pass a plain object because Jest runs as CommonJS, where `import.meta` is not available.
export function getEnv(name: PublicEnvName, source?: EnvSource): string | undefined {
  if (source !== undefined) {
    return source[name];
  }
  return readViteEnv(name);
}
