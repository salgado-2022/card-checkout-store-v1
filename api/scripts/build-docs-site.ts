import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Assembles docs/site/: the Swagger UI assets, an index page and a copy of docs/openapi.json.
// The page loads only same-origin files under /docs/ so it satisfies the Docs_Headers_Policy
// (script-src 'self', style-src 'self') without inline scripts or styles.

export const DOCS_PREFIX = '/docs';
export const DEFAULT_OUTPUT_DIR = resolve(__dirname, '..', '..', 'docs', 'site');
export const DEFAULT_OPENAPI_PATH = resolve(__dirname, '..', '..', 'docs', 'openapi.json');
export const INDEX_FILE = 'index.html';
export const INITIALIZER_FILE = 'swagger-initializer.js';
export const OPENAPI_FILE = 'openapi.json';

// Only the files the page needs. Source maps and the unused bundles (es-bundle, core) are left out.
const SWAGGER_UI_ASSETS = [
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-32x32.png',
  'LICENSE',
] as const;

const DEFAULT_SWAGGER_UI_DIST_DIR = dirname(require.resolve('swagger-ui-dist/package.json'));

export interface BuildDocsSiteOptions {
  readonly outputDir?: string;
  readonly openApiPath?: string;
  readonly swaggerUiDistDir?: string;
}

const docsUrl = (fileName: string): string => `${DOCS_PREFIX}/${fileName}`;

export function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documentación de la API</title>
<link rel="icon" type="image/png" sizes="32x32" href="${docsUrl('favicon-32x32.png')}">
<link rel="stylesheet" href="${docsUrl('swagger-ui.css')}">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${docsUrl('swagger-ui-bundle.js')}"></script>
<script src="${docsUrl('swagger-ui-standalone-preset.js')}"></script>
<script src="${docsUrl(INITIALIZER_FILE)}"></script>
</body>
</html>
`;
}

export function renderInitializerJs(): string {
  return `window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '${docsUrl(OPENAPI_FILE)}',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    validatorUrl: null
  });
};
`;
}

export function buildDocsSite(options: BuildDocsSiteOptions = {}): void {
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const openApiPath = options.openApiPath ?? DEFAULT_OPENAPI_PATH;
  const swaggerUiDistDir = options.swaggerUiDistDir ?? DEFAULT_SWAGGER_UI_DIST_DIR;

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  for (const asset of SWAGGER_UI_ASSETS) {
    copyFileSync(join(swaggerUiDistDir, asset), join(outputDir, asset));
  }
  copyFileSync(openApiPath, join(outputDir, OPENAPI_FILE));
  writeFileSync(join(outputDir, INITIALIZER_FILE), renderInitializerJs());
  writeFileSync(join(outputDir, INDEX_FILE), renderIndexHtml());
}

if (require.main === module) {
  buildDocsSite();
  process.stdout.write(`Docs site written to ${DEFAULT_OUTPUT_DIR}\n`);
}
