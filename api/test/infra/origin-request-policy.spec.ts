import * as fs from 'node:fs';
import * as path from 'node:path';
// Static checks over the CloudFront origin request policy for /api/*.
// The Terraform and workflow files are read as text: no terraform binary and no AWS calls.
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');
const DEPLOY_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/deploy.yml');
const EXPECTED_HEADERS = [
  'CloudFront-Viewer-Address',
  'Content-Type',
  'Accept',
  'Idempotency-Key',
  'X-Event-Checksum',
  'X-Request-Id',
];
interface Block {
  labels: string[];
  body: string;
}
function readInfraText(): string {
  return fs
    .readdirSync(INFRA_DIR)
    .filter((name) => name.endsWith('.tf'))
    .sort()
    .map((name) => fs.readFileSync(path.join(INFRA_DIR, name), 'utf8'))
    .join('\n');
}
// Index of the brace that closes the block opened at `open`.
function closingIndex(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces in Terraform text');
}
// Every block whose header starts with `kind` (resource, data, variable, ...) at any depth.
function blocksOf(text: string, kind: string): Block[] {
  const header = new RegExp(`^[ \\t]*${kind}((?:[ \\t]+"[^"\\n]*")*)[ \\t]*\\{`, 'gm');
  return [...text.matchAll(header)].map((match) => {
    const open = (match.index ?? 0) + match[0].length - 1;
    const labels = [...match[1].matchAll(/"([^"]*)"/g)].map((label) => label[1]);
    return { labels, body: text.slice(open + 1, closingIndex(text, open)) };
  });
}
// Body of the named block, or a failing expectation when it is missing.
function requireBlock(blocks: Block[], label: string): Block {
  const found = blocks.find((block) => block.labels.includes(label));
  if (!found) {
    throw new Error(`block "${label}" not found`);
  }
  return found;
}
// Keeps only the text written directly in a block body, without nested blocks.
function topLevel(body: string): string {
  let depth = 0;
  let out = '';
  for (const ch of body) {
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}
function attribute(text: string, name: string): string {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.+)$`, 'm').exec(text);
  if (!match) {
    throw new Error(`attribute not found: ${name}`);
  }
  return match[1].trim();
}
function stringItems(body: string): string[] {
  const list = /items[ \t]*=[ \t]*\[([\s\S]*?)\]/.exec(body);
  if (!list) {
    throw new Error('items list not found');
  }
  return [...list[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]);
}
const infra = readInfraText();
const resources = blocksOf(infra, 'resource');
const policy = requireBlock(
  resources.filter((block) => block.labels[0] === 'aws_cloudfront_origin_request_policy'),
  'api',
);
const headersConfig = blocksOf(policy.body, 'headers_config')[0];
const headersBlock = blocksOf(headersConfig?.body ?? '', 'headers')[0];
const whitelist = stringItems(headersBlock?.body ?? '');
const distribution = requireBlock(
  resources.filter((block) => block.labels[0] === 'aws_cloudfront_distribution'),
  'web',
);
describe('CloudFront origin request policy for /api/*', () => {
  it('is a custom resource named with the project prefix', () => {
    expect(policy.labels).toEqual(['aws_cloudfront_origin_request_policy', 'api']);
    expect(attribute(policy.body, 'name')).toBe('"${var.project_name}-api"');
  });
  it('whitelists exactly the six API headers, case-insensitive, with no Host', () => {
    expect(attribute(topLevel(headersConfig.body), 'header_behavior')).toBe('"whitelist"');
    const normalized = (names: string[]) => names.map((name) => name.toLowerCase()).sort();
    expect(normalized(whitelist)).toEqual(normalized(EXPECTED_HEADERS));
    expect(whitelist.map((name) => name.toLowerCase())).not.toContain('host');
  });
  it('forwards no cookies and every query string', () => {
    const cookies = blocksOf(policy.body, 'cookies_config')[0];
    expect(attribute(topLevel(cookies.body), 'cookie_behavior')).toBe('"none"');
    const queries = blocksOf(policy.body, 'query_strings_config')[0];
    expect(attribute(topLevel(queries.body), 'query_string_behavior')).toBe('"all"');
  });
  it('is the only origin request policy on the /api/* behavior', () => {
    const behaviors = blocksOf(distribution.body, 'ordered_cache_behavior');
    const api = behaviors.find(
      (block) => attribute(topLevel(block.body), 'path_pattern') === '"/api/*"',
    );
    expect(api).toBeDefined();
    expect(attribute(topLevel(api?.body ?? ''), 'origin_request_policy_id')).toBe(
      'aws_cloudfront_origin_request_policy.api.id',
    );
  });
  it('declares no data source and no variable selecting an origin request policy', () => {
    expect(infra).not.toMatch(/data[ \t]+"aws_cloudfront_origin_request_policy"/);
    const variableNames = blocksOf(infra, 'variable').map((block) => block.labels[0] ?? '');
    expect(variableNames.filter((name) => /origin_request_policy/i.test(name))).toEqual([]);
  });
  it('keeps X-Origin-Verify as the Lambda origin custom header and out of the whitelist', () => {
    const origins = blocksOf(distribution.body, 'origin');
    const lambdaOrigin = origins.find((origin) =>
      /origin_id[ \t]*=[ \t]*local\.lambda_origin_id/.test(origin.body),
    );
    expect(lambdaOrigin).toBeDefined();
    const headers = blocksOf(lambdaOrigin?.body ?? '', 'custom_header');
    const verify = headers.find((header) => /name[ \t]*=[ \t]*"X-Origin-Verify"/.test(header.body));
    expect(verify).toBeDefined();
    expect(whitelist.map((name) => name.toLowerCase())).not.toContain('x-origin-verify');
  });
  it('passes no origin request policy variable from deploy.yml to Terraform', () => {
    const workflow = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
    expect(workflow).not.toMatch(/origin_request_policy/i);
  });
});
