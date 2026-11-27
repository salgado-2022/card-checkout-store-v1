export const MAX_PROVIDER_REASON_LENGTH = 200;

// Control characters (C0, DEL, C1), format characters (bidi overrides, zero-width) and the two
// Unicode line and paragraph separators.
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * Turns the free text a payment provider sent for a final status into a `statusReason` that is
 * safe to store: control characters removed, trimmed, cut to 200 characters. Returns `undefined`
 * when nothing is left, so callers omit the reason. The text is untrusted: callers must never
 * write it to a log.
 */
export function providerReason(message: string | null | undefined): string | undefined {
  if (typeof message !== 'string') {
    return undefined;
  }
  const cleaned = message.replace(CONTROL_CHARACTERS, '').trim();
  const reason = Array.from(cleaned).slice(0, MAX_PROVIDER_REASON_LENGTH).join('').trim();
  return reason.length === 0 ? undefined : reason;
}
