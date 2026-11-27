import type { IncomingMessage, ServerResponse } from 'node:http';
import { envelopeFor } from '../error-catalog';

export const JSON_MEDIA_TYPE = 'application/json';
export const UTF_8_CHARSET = 'utf-8';

export interface ParsedContentType {
  mediaType: string;
  // Every `charset` parameter value, lower-cased and unquoted. Empty when the header has none.
  charsets: string[];
}

// Splits at each `;` that is outside a quoted string, so `charset="a;b"` keeps its value whole.
function splitParameters(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header.charAt(index);
    if (inQuotes && char === '\\') {
      current += header.slice(index, index + 2);
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ';' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  const isQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  return isQuoted ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
}

// Compares only parsed parts: the media type and the parameter names are lower-cased, and the
// charset value is lower-cased after unquoting. The raw header string is never compared.
export function parseContentType(header: string): ParsedContentType {
  const [rawMediaType = '', ...parameters] = splitParameters(header);
  const charsets: string[] = [];
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name === 'charset') {
      charsets.push(unquote(parameter.slice(separator + 1).trim()).toLowerCase());
    }
  }
  return { mediaType: rawMediaType.trim().toLowerCase(), charsets };
}

function isAcceptedContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const parsed = parseContentType(header);
  return (
    parsed.mediaType === JSON_MEDIA_TYPE &&
    parsed.charsets.every((charset) => charset === UTF_8_CHARSET)
  );
}

// A POST carries a body when it sends Transfer-Encoding, or a Content-Length that is not zero.
// An unreadable Content-Length counts as a body, so the guard fails closed.
export function hasRequestBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) {
    return true;
  }
  const length = req.headers['content-length'];
  if (length === undefined) {
    return false;
  }
  const value = Number(length);
  return Number.isNaN(value) || value > 0;
}

// Mounted before the body parser, so a body with the wrong type is never parsed.
export function contentTypeGuardMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (req.method !== 'POST' || !hasRequestBody(req)) {
    next();
    return;
  }
  if (isAcceptedContentType(req.headers['content-type'])) {
    next();
    return;
  }
  res.statusCode = envelopeFor('UNSUPPORTED_MEDIA_TYPE').statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(envelopeFor('UNSUPPORTED_MEDIA_TYPE')));
}
