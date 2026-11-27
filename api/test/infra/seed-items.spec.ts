import * as fs from 'fs';
import * as path from 'path';

// Static checks on the Terraform-seeded catalog (task 1.15). The Terraform files
// are read as text and never applied.
const repoRoot = path.resolve(__dirname, '../../..');
const apiRoot = path.resolve(repoRoot, 'api');
const dynamodbTf = fs.readFileSync(path.resolve(repoRoot, 'infra', 'dynamodb.tf'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(apiRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const deploymentDoc = fs.readFileSync(path.resolve(repoRoot, 'docs', 'deployment.md'), 'utf8');
const readme = fs.readFileSync(path.resolve(repoRoot, 'README.md'), 'utf8');

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

interface SeedItem {
  readonly name: string;
  readonly body: string;
  readonly fields: Record<string, string>;
}

// Parses every aws_dynamodb_table_item block and the { S = "..." } / { N = "..." } fields of its item.
function parseSeedItems(source: string): SeedItem[] {
  const blockPattern = /resource "aws_dynamodb_table_item" "(\w+)" \{([\s\S]*?)\n\}/g;
  const items: SeedItem[] = [];
  for (const match of source.matchAll(blockPattern)) {
    const [, name, body] = match;
    const fields: Record<string, string> = {};
    for (const field of body.matchAll(/(\w+)\s*=\s*\{\s*[SN]\s*=\s*"([^"]*)"\s*\}/g)) {
      fields[field[1]] = field[2];
    }
    items.push({ name, body, fields });
  }
  return items;
}

const items = parseSeedItems(dynamodbTf);

describe('Terraform-seeded catalog (task 1.15)', () => {
  it('defines exactly 4 aws_dynamodb_table_item resources', () => {
    expect(items).toHaveLength(4);
  });

  it('places every seed item on the products table', () => {
    for (const item of items) {
      expect(item.body).toContain('table_name = aws_dynamodb_table.products.name');
      expect(item.body).toContain('hash_key   = aws_dynamodb_table.products.hash_key');
    }
  });

  it('gives each item a unique ULID-format id', () => {
    const ids = items.map((item) => item.fields.id);
    for (const id of ids) {
      expect(id).toMatch(ULID_PATTERN);
    }
    expect(new Set(ids).size).toBe(4);
  });

  it('gives one product stock 0, one stock 1 and two stock between 2 and 20', () => {
    const stocks = items.map((item) => Number(item.fields.stock)).sort((a, b) => a - b);
    expect(stocks[0]).toBe(0);
    expect(stocks[1]).toBe(1);
    expect(stocks[2]).toBeGreaterThanOrEqual(2);
    expect(stocks[2]).toBeLessThanOrEqual(20);
    expect(stocks[3]).toBeGreaterThanOrEqual(2);
    expect(stocks[3]).toBeLessThanOrEqual(20);
  });

  it('sets an imageUrl under /images/ ending in .webp', () => {
    for (const item of items) {
      expect(item.fields.imageUrl).toMatch(/^\/images\/.+\.webp$/);
    }
  });

  it('sets currency to COP', () => {
    for (const item of items) {
      expect(item.fields.currency).toBe('COP');
    }
  });

  it('sets priceInCents to a positive integer', () => {
    for (const item of items) {
      expect(item.fields.priceInCents).toMatch(/^[1-9][0-9]*$/);
    }
  });

  it('declares ignore_changes = [item] on every item', () => {
    for (const item of items) {
      expect(item.body).toMatch(/lifecycle\s*\{\s*ignore_changes\s*=\s*\[item\]\s*\}/);
    }
  });

  it('removes the placeholder seed script', () => {
    expect(fs.existsSync(path.resolve(apiRoot, 'scripts', 'seed.ts'))).toBe(false);
  });

  it('has no seed script in api/package.json', () => {
    const scriptNames = Object.keys(packageJson.scripts ?? {});
    expect(scriptNames.some((name) => name.toLowerCase().includes('seed'))).toBe(false);
  });

  it('has no manual seed step in docs/deployment.md or README.md', () => {
    expect(deploymentDoc.toLowerCase()).not.toContain('seed.ts');
    expect(deploymentDoc.toLowerCase()).not.toMatch(/npm run seed|manual seed/);
    expect(readme.toLowerCase()).not.toContain('seed.ts');
    expect(readme.toLowerCase()).not.toMatch(/npm run seed|manual seed/);
  });
});
