const MASK = '*';
const DOCUMENT_VISIBLE_CHARS = 3;

const EMAIL_FIELDS: ReadonlySet<string> = new Set(['email', 'customerEmail']);
const DOCUMENT_FIELDS: ReadonlySet<string> = new Set(['documentNumber']);

// Keeps the first character of the local part, masks the rest, and keeps the domain as is.
// Short values reveal less: a one-character local part is fully masked, and a value without
// '@' is masked entirely. Masking an already masked value returns it unchanged.
export function maskEmail(email: string): string {
  if (email.length === 0) {
    return '';
  }
  const at = email.lastIndexOf('@');
  if (at < 0) {
    return MASK.repeat(3);
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length === 0) {
    return domain;
  }
  if (local.length === 1) {
    return `${MASK}${domain}`;
  }
  return `${local.charAt(0)}${MASK.repeat(3)}${domain}`;
}

// Replaces every character except the last three with '*' and keeps the length. Values of three
// characters or fewer are fully masked, so the last three characters never equal the whole value.
export function maskDocumentNumber(documentNumber: string): string {
  if (documentNumber.length <= DOCUMENT_VISIBLE_CHARS) {
    return MASK.repeat(documentNumber.length);
  }
  const hidden = documentNumber.length - DOCUMENT_VISIBLE_CHARS;
  return `${MASK.repeat(hidden)}${documentNumber.slice(-DOCUMENT_VISIBLE_CHARS)}`;
}

// Masks the fields named `email`, `customerEmail` and `documentNumber` so no caller has to
// remember to mask them. Numbers are masked as their string form; other values pass through.
export function maskSensitiveFields<V>(
  fields: Readonly<Record<string, V>>,
): Record<string, V | string> {
  const masked: Record<string, V | string> = {};
  for (const [name, value] of Object.entries(fields)) {
    masked[name] = maskValue(name, value);
  }
  return masked;
}

function maskValue<V>(name: string, value: V): V | string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  if (text === null) {
    return value;
  }
  if (EMAIL_FIELDS.has(name)) {
    return maskEmail(text);
  }
  if (DOCUMENT_FIELDS.has(name)) {
    return maskDocumentNumber(text);
  }
  return value;
}

const MAX_FREE_TEXT_CHARS = 300;
const EMAIL_IN_TEXT = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/g;
// Six or more digits, optionally split by spaces or dashes: documents, phones and card numbers.
const DIGIT_RUN_IN_TEXT = /\d(?:[\s-]?\d){5,}/g;

// For free text such as an unexpected exception message: masks every email and every run of six
// or more digits, then truncates, so a raw message cannot leak personal data into the logs.
export function maskFreeText(text: string): string {
  const masked = text
    .replace(EMAIL_IN_TEXT, (email) => maskEmail(email))
    .replace(DIGIT_RUN_IN_TEXT, (digits) => maskDocumentNumber(digits.replace(/[\s-]/g, '')));
  return masked.length > MAX_FREE_TEXT_CHARS ? `${masked.slice(0, MAX_FREE_TEXT_CHARS)}…` : masked;
}
