import { createHash } from 'node:crypto';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Serializes a JSON value with object keys sorted recursively and array order
 * preserved, so two bodies that differ only in key order produce the same text.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Request_Hash: SHA-256 hex digest of the canonical JSON form of the request body. */
export function requestHash(body: JsonValue): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}
