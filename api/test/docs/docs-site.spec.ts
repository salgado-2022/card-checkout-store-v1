import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildDocsSite,
  DOCS_PREFIX,
  INDEX_FILE,
  INITIALIZER_FILE,
  OPENAPI_FILE,
} from '../../scripts/build-docs-site';

const SWAGGER_UI_DIST_DIR = resolve(__dirname, '..', '..', 'node_modules', 'swagger-ui-dist');
const ASSET_FILES = [
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-32x32.png',
  'LICENSE',
];
const FIXTURE_OPENAPI = '{\n  "openapi": "3.0.0",\n  "paths": {}\n}\n';

const ATTRIBUTE_REFERENCE = /\b(?:src|href)\s*=\s*"([^"]*)"/g;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>/i;

describe('buildDocsSite', () => {
  let workDir: string;
  let outputDir: string;
  let openApiPath: string;
  let indexHtml: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'docs-site-'));
    outputDir = join(workDir, 'site');
    openApiPath = join(workDir, 'openapi.json');
    writeFileSync(openApiPath, FIXTURE_OPENAPI);
    buildDocsSite({ outputDir, openApiPath, swaggerUiDistDir: SWAGGER_UI_DIST_DIR });
    indexHtml = readFileSync(join(outputDir, INDEX_FILE), 'utf8');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the index, the initializer, the OpenAPI copy and the Swagger UI assets', () => {
    for (const file of [INDEX_FILE, INITIALIZER_FILE, OPENAPI_FILE, ...ASSET_FILES]) {
      expect(existsSync(join(outputDir, file))).toBe(true);
    }
  });

  it('copies the OpenAPI document byte for byte', () => {
    expect(readFileSync(join(outputDir, OPENAPI_FILE), 'utf8')).toBe(FIXTURE_OPENAPI);
  });

  it('replaces the petstore initializer with one that points at the copied document', () => {
    const initializer = readFileSync(join(outputDir, INITIALIZER_FILE), 'utf8');

    expect(initializer).toContain(`url: '${DOCS_PREFIX}/${OPENAPI_FILE}'`);
    expect(initializer).not.toContain('petstore');
  });
  it('disables the external validator badge so the spec URL is never sent to a third party', () => {
    const initializer = readFileSync(join(outputDir, INITIALIZER_FILE), 'utf8');
    expect(initializer).toContain('validatorUrl: null');
    expect(initializer).not.toContain('validator.swagger.io');
  });

  it('keeps every script in the index as an external file', () => {
    expect(INLINE_SCRIPT.test(indexHtml)).toBe(false);
    expect(indexHtml).toContain(`<script src="${DOCS_PREFIX}/${INITIALIZER_FILE}"></script>`);
  });

  it('has no <style> element, no style attribute and no data: URL', () => {
    expect(indexHtml).not.toMatch(/<style[\s>]/i);
    expect(indexHtml).not.toMatch(/\sstyle\s*=/i);
    expect(indexHtml).not.toContain('data:');
  });

  it('references only assets under the /docs/ prefix', () => {
    const references = [...indexHtml.matchAll(ATTRIBUTE_REFERENCE)].map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference?.startsWith(`${DOCS_PREFIX}/`)).toBe(true);
    }
  });

  it('removes files left by a previous build in the output directory', () => {
    const staleFile = join(outputDir, 'stale.txt');
    writeFileSync(staleFile, 'old');

    buildDocsSite({ outputDir, openApiPath, swaggerUiDistDir: SWAGGER_UI_DIST_DIR });

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(join(outputDir, INDEX_FILE))).toBe(true);
  });
});
