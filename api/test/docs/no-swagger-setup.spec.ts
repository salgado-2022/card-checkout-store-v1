import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const srcRoot = resolve(__dirname, '..', '..', 'src');

// The Lambda bundle cannot serve Swagger UI assets, so the runtime entry points must never mount it.
const ENTRY_POINTS: readonly string[] = [
  'main.ts',
  'lambda.ts',
  join('infrastructure', 'http', 'create-app.ts'),
];

describe('Swagger UI is not mounted at runtime', () => {
  it.each(ENTRY_POINTS)('%s does not call SwaggerModule.setup', (relativePath) => {
    const source = readFileSync(join(srcRoot, relativePath), 'utf8');
    expect(source).not.toMatch(/SwaggerModule\s*\.\s*setup\s*\(/);
  });
});
