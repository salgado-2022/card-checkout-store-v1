import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';

interface CloudFrontRequest {
  uri: string;
}

type DocsHandler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

const TF_PATH = path.resolve(__dirname, '../../../infra/cloudfront_function.tf');
const START_MARKER = '// DOCS_INDEX_REWRITE_START';
const END_MARKER = '// DOCS_INDEX_REWRITE_END';

function extractFunctionBody(tf: string): string {
  const start = tf.indexOf(START_MARKER);
  const end = tf.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('DOCS_INDEX_REWRITE markers not found in cloudfront_function.tf');
  }
  return tf.slice(start + START_MARKER.length, end);
}

function loadHandler(): DocsHandler {
  const body = extractFunctionBody(readFileSync(TF_PATH, 'utf8'));
  // The body is the CloudFront Function source. Evaluating it isolates the rewrite logic.
  const factory = new Function(`${body}\nreturn handler;`) as () => DocsHandler;
  return factory();
}

function rewrite(handler: DocsHandler, uri: string): string {
  return handler({ request: { uri } }).uri;
}

// Oracle written from the requirement: only the exact URIs /docs and /docs/ are rewritten.
function expectedUri(uri: string): string {
  return uri === '/docs' || uri === '/docs/' ? '/docs/index.html' : uri;
}

const segmentChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('');
const segment = fc
  .array(fc.constantFrom(...segmentChars), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(''));
const docsPath = fc
  .array(segment, { minLength: 0, maxLength: 4 })
  .map((parts) => `/docs/${parts.join('/')}`);
const anyPath = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom('/docs', '/docs/') },
  { weight: 2, arbitrary: docsPath },
  {
    weight: 2,
    arbitrary: fc
      .array(segment, { minLength: 0, maxLength: 4 })
      .map((parts) => `/${parts.join('/')}`),
  },
);

describe('docs index rewrite CloudFront Function', () => {
  let handler: DocsHandler;

  beforeAll(() => {
    handler = loadHandler();
  });

  it('is extracted between the markers and evaluates to a handler', () => {
    expect(extractFunctionBody(readFileSync(TF_PATH, 'utf8'))).toContain('function handler(event)');
    expect(typeof handler).toBe('function');
  });

  it('throws when the markers are missing', () => {
    expect(() => extractFunctionBody('no markers here')).toThrow(
      'DOCS_INDEX_REWRITE markers not found',
    );
  });

  it.each([
    ['/docs', '/docs/index.html'],
    ['/docs/', '/docs/index.html'],
    ['/docs/openapi.json', '/docs/openapi.json'],
    ['/docs/index.html', '/docs/index.html'],
    ['/docs/assets/app.js', '/docs/assets/app.js'],
    ['/docs/guide/', '/docs/guide/'],
    ['/', '/'],
    ['/api/v1/products', '/api/v1/products'],
  ])('maps %s to %s', (uri, expected) => {
    expect(rewrite(handler, uri)).toBe(expected);
  });

  it('returns the same request object when the URI is left unchanged', () => {
    const request: CloudFrontRequest = { uri: '/docs/openapi.json' };
    expect(handler({ request })).toBe(request);
  });

  it('Feature: payments-api, Property 45: the docs index function rewrites only the exact /docs and /docs/ URIs', () => {
    fc.assert(
      fc.property(anyPath, (uri) => {
        expect(rewrite(handler, uri)).toBe(expectedUri(uri));
      }),
      { numRuns: 100 },
    );
  });
});
