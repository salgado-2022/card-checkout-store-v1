import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';

interface CloudFrontRequest {
  uri: string;
}

type SpaHandler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

const TF_PATH = path.resolve(__dirname, '../../../infra/cloudfront_function.tf');
const START_MARKER = '// SPA_REWRITE_START';
const END_MARKER = '// SPA_REWRITE_END';

function extractFunctionBody(tf: string): string {
  const start = tf.indexOf(START_MARKER);
  const end = tf.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('SPA_REWRITE markers not found in cloudfront_function.tf');
  }
  return tf.slice(start + START_MARKER.length, end);
}

function loadHandler(): SpaHandler {
  const body = extractFunctionBody(readFileSync(TF_PATH, 'utf8'));
  // The body is the CloudFront Function source. Evaluating it isolates the rewrite logic.
  const factory = new Function(`${body}\nreturn handler;`) as () => SpaHandler;
  return factory();
}

function rewrite(handler: SpaHandler, uri: string): string {
  return handler({ request: { uri } }).uri;
}

// Oracle written from the requirement, independent of the implementation:
// rewrite when the last segment has no extension and the path is neither under /api/ nor under /docs/.
function expectedUri(uri: string): string {
  const lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  const hasExtension = lastSegment.includes('.');
  const isApi = uri.startsWith('/api/');
  const isDocs = uri.startsWith('/docs/');
  return !hasExtension && !isApi && !isDocs ? '/index.html' : uri;
}

const segmentChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('');
const extensionChars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const charsOf = (chars: string[], minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...chars), { minLength, maxLength }).map((letters) => letters.join(''));
const plainSegment = charsOf(segmentChars, 1, 10);
const extension = charsOf(extensionChars, 1, 5);
const fileSegment = fc.tuple(plainSegment, extension).map(([name, ext]) => `${name}.${ext}`);
const anySegment = fc.oneof(plainSegment, fileSegment);
const segments = fc.array(anySegment, { minLength: 0, maxLength: 5 });

const pathFromSegments = (parts: string[]): string => `/${parts.join('/')}`;

// Paths under /api/ in several shapes, including nested and extension-bearing ones.
const apiPath = fc
  .tuple(fc.constantFrom('/api/', '/api/v1/', '/api/'), segments)
  .map(([prefix, parts]) => `${prefix}${parts.join('/')}`);

// Paths under /docs/ in several shapes, including extension-less ones such as /docs/api-guide.
const docsPath = fc
  .tuple(fc.constantFrom('/docs/', '/docs/nested/'), segments)
  .map(([prefix, parts]) => `${prefix}${parts.join('/')}`);
const anyPath = fc.oneof(
  { weight: 3, arbitrary: segments.map(pathFromSegments) },
  { weight: 2, arbitrary: apiPath },
  { weight: 2, arbitrary: docsPath },
);

describe('SPA rewrite CloudFront Function', () => {
  let handler: SpaHandler;

  beforeAll(() => {
    handler = loadHandler();
  });

  it('is extracted between the markers and evaluates to a handler', () => {
    expect(extractFunctionBody(readFileSync(TF_PATH, 'utf8'))).toContain('function handler(event)');
    expect(typeof handler).toBe('function');
  });

  it('throws when the markers are missing', () => {
    expect(() => extractFunctionBody('no markers here')).toThrow('SPA_REWRITE markers not found');
  });

  it.each([
    ['/', '/index.html'],
    ['/some/deep/route', '/index.html'],
    ['/assets/app.abc123.js', '/assets/app.abc123.js'],
    ['/api/v1/unknown-route', '/api/v1/unknown-route'],
    ['/products/42', '/index.html'],
    ['/favicon.ico', '/favicon.ico'],
    ['/docs/', '/docs/'],
    ['/docs/index.html', '/docs/index.html'],
    ['/docs/openapi.json', '/docs/openapi.json'],
    ['/docs/guide', '/docs/guide'],
    ['/docs', '/index.html'],
  ])('rewrites %s to the expected URI %s', (uri, expected) => {
    expect(rewrite(handler, uri)).toBe(expected);
  });

  it('returns the same request object when the URI is left unchanged', () => {
    const request: CloudFrontRequest = { uri: '/assets/app.abc123.js' };
    expect(handler({ request })).toBe(request);
  });

  it('Feature: payments-api, Property 44: SPA rewrite leaves /api/ and /docs/ unchanged and rewrites other extension-less paths', () => {
    fc.assert(
      fc.property(anyPath, (uri) => {
        expect(rewrite(handler, uri)).toBe(expectedUri(uri));
      }),
      { numRuns: 100 },
    );
  });
});
