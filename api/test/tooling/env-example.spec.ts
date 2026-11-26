import * as fs from 'fs';
import * as path from 'path';

const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../../../.env.example');

const REQUIRED_NAMES: readonly string[] = [
  'PAYMENT_API_URL',
  'PAYMENT_PUBLIC_KEY',
  'PAYMENT_PRIVATE_KEY_PARAM',
  'PAYMENT_INTEGRITY_SECRET_PARAM',
  'PAYMENT_EVENTS_SECRET_PARAM',
  'ORIGIN_VERIFY_SECRET_PARAM',
  'BASE_FEE_IN_CENTS',
  'DELIVERY_FEE_IN_CENTS',
  'DYNAMODB_TABLE_PRODUCTS',
  'DYNAMODB_TABLE_CUSTOMERS',
  'DYNAMODB_TABLE_TRANSACTIONS',
  'DYNAMODB_TABLE_DELIVERIES',
  'DYNAMODB_TABLE_IDEMPOTENCY_KEYS',
  'VITE_API_BASE',
  'VITE_PAYMENT_API_URL',
  'VITE_PAYMENT_PUBLIC_KEY',
];

const ALLOWED_DEFAULTS: Readonly<Record<string, string>> = {
  BASE_FEE_IN_CENTS: '300000',
  DELIVERY_FEE_IN_CENTS: '800000',
  VITE_API_BASE: '/api/v1',
};

const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const LONG_RANDOM_VALUE = /^[A-Za-z0-9+/_=-]{20,}$/;

interface Assignment {
  readonly name: string;
  readonly value: string;
}

function readAssignments(): Assignment[] {
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const assignments: Assignment[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = ASSIGNMENT.exec(line);
    if (match) {
      assignments.push({ name: match[1], value: match[2] });
    }
  }
  return assignments;
}

describe('.env.example', () => {
  const assignments = readAssignments();

  it.each(REQUIRED_NAMES)('declares the variable %s', (name) => {
    expect(assignments.map((assignment) => assignment.name)).toContain(name);
  });

  it('contains no private key prefix anywhere in the file, comments included', () => {
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    expect(content.includes('prv_')).toBe(false);
  });

  it('never assigns a value that looks like a secret', () => {
    for (const { name, value } of assignments) {
      expect({ name, containsPrv: value.includes('prv_') }).toEqual({ name, containsPrv: false });
      expect({ name, longRandom: LONG_RANDOM_VALUE.test(value) }).toEqual({ name, longRandom: false });
    }
  });

  it('assigns non-empty values only for the three allowed defaults', () => {
    const nonEmpty: Record<string, string> = {};
    for (const { name, value } of assignments) {
      if (value !== '') {
        nonEmpty[name] = value;
      }
    }
    expect(nonEmpty).toEqual(ALLOWED_DEFAULTS);
  });
});
