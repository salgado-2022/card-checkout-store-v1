import type { ApplicationLogger } from '../../../application/ports/application-logger';
import { type LogFields, type LogFieldValue, JsonLogger } from './json-logger';
import { maskSensitiveFields } from './mask';

// Fragments checked against the normalized key (lower case, letters only), so `Card_Number`,
// `idempotencyKey` and `X-Origin-Verify` are caught the same way.
const SECRET_KEY_FRAGMENTS = [
  'key',
  'secret',
  'token',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'cvc',
  'cvv',
  'cardnumber',
  'credential',
  'originverify',
];

const isSecretKey = (name: string): boolean => {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
};

const isLogValue = (value: unknown): value is LogFieldValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

// Keeps primitive fields whose names are not secret-like, then masks email and document fields.
// Objects, arrays and functions are dropped, so whole request bodies or headers never reach the
// output by accident.
export function sanitizeLogFields(fields: Readonly<Record<string, unknown>> = {}): LogFields {
  const safe: Record<string, LogFieldValue> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!isSecretKey(name) && isLogValue(value)) {
      safe[name] = value;
    }
  }
  return maskSensitiveFields(safe);
}

// Implements the logging port on top of the JSON logger. Each call writes one JSON line.
// `requestId` and `reference` travel as ordinary fields when the caller passes them.
// `alert` is written at error level so it reaches stderr and the CloudWatch error stream.
export class ApplicationLoggerAdapter implements ApplicationLogger {
  constructor(private readonly logger: JsonLogger) {}

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.logger.info(message, sanitizeLogFields(fields));
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.logger.warn(message, sanitizeLogFields(fields));
  }

  alert(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.logger.error(message, sanitizeLogFields(fields));
  }
}
