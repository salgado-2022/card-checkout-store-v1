import { createHash, timingSafeEqual } from 'node:crypto';

// Hashing both inputs gives two 32-byte digests, so timingSafeEqual never
// receives buffers of different lengths (it throws in that case).
// UTF-16LE keeps every code unit distinct, including lone surrogates.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf16le').digest();

export function timingSafeEqualStrings(expected: string, received: string): boolean {
  return timingSafeEqual(digest(expected), digest(received));
}
