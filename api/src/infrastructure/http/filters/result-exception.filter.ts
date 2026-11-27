import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  CatalogHttpException,
  type ErrorCode,
  type ErrorEnvelope,
  envelopeFor,
} from '../error-catalog';
import { JsonLogger } from '../logging/json-logger';
import { maskFreeText } from '../logging/mask';
import type { RequestWithId } from '../middleware/request-id.middleware';

export type { ErrorEnvelope } from '../error-catalog';

interface LoggerPort {
  warn(message: string, fields?: Record<string, string | number | undefined>): void;
  error(message: string, fields?: Record<string, string | number | undefined>): void;
}

const INTERNAL_ERROR_STATUS = 500;
const MALFORMED_JSON_MESSAGE = 'Malformed JSON body.';
const UNREADABLE_BODY_MESSAGE = 'Request body could not be read.';

// body-parser and raw-body error types. Encoding and charset problems are 415; the rest mean the
// body could not be read and are 400. Their messages can quote the request, so none is reused.
const UNSUPPORTED_BODY_TYPES: ReadonlySet<string> = new Set([
  'encoding.unsupported',
  'charset.unsupported',
]);
const UNREADABLE_BODY_TYPES: ReadonlySet<string> = new Set([
  'request.aborted',
  'request.size.invalid',
  'parameters.too.many',
]);

// Framework HttpExceptions that carry no catalog envelope map to these codes. Any other status
// is a server-side surprise and becomes INTERNAL_ERROR.
const CODE_BY_FRAMEWORK_STATUS: Readonly<Partial<Record<number, ErrorCode>>> = {
  400: 'VALIDATION_ERROR',
  404: 'ROUTE_NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

// Single exception filter: every response uses the fixed envelope and never includes a stack trace.
// Constructed with `new` in the bootstrap (app.useGlobalFilters), so it needs no DI provider.
@Catch()
export class ResultExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerPort = new JsonLogger()) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();
    const envelope = toEnvelope(exception);

    this.log(exception, envelope, req.requestId);
    res.status(envelope.statusCode).json(envelope);
  }

  private log(exception: unknown, envelope: ErrorEnvelope, requestId: string | undefined): void {
    const kind = sourceKind(exception);
    const fields = {
      requestId,
      statusCode: envelope.statusCode,
      code: envelope.code,
      errorName: errorName(exception),
      ...(kind === undefined ? {} : { kind }),
    };

    if (envelope.statusCode >= INTERNAL_ERROR_STATUS) {
      this.logger.error('Request failed', { ...fields, errorMessage: errorMessage(exception) });
    } else {
      // 4xx messages can echo client input (for example a body-parser excerpt), so they are not logged.
      this.logger.warn('Request rejected', fields);
    }
  }
}

// body-parser errors are not HttpExceptions; they carry a `type`. The original message can quote
// the request body, so these envelopes use fixed messages.
function bodyParserEnvelope(exception: unknown): ErrorEnvelope | undefined {
  const type = (exception as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') {
    return { ...envelopeFor('VALIDATION_ERROR'), message: MALFORMED_JSON_MESSAGE };
  }
  if (type === 'entity.too.large') {
    return envelopeFor('PAYLOAD_TOO_LARGE');
  }
  if (typeof type === 'string' && UNSUPPORTED_BODY_TYPES.has(type)) {
    return envelopeFor('UNSUPPORTED_MEDIA_TYPE');
  }
  if (typeof type === 'string' && UNREADABLE_BODY_TYPES.has(type)) {
    return { ...envelopeFor('VALIDATION_ERROR'), message: UNREADABLE_BODY_MESSAGE };
  }
  // A failed decompression (for example a corrupt gzip body) reaches the filter as an untyped
  // http-errors 400 with `expose: true`. It is a client error, not a server failure.
  if (type === undefined && isExposedBadRequest(exception)) {
    return { ...envelopeFor('VALIDATION_ERROR'), message: UNREADABLE_BODY_MESSAGE };
  }
  return undefined;
}

function isExposedBadRequest(exception: unknown): boolean {
  if (exception instanceof HttpException) {
    return false;
  }
  const candidate = exception as { status?: unknown; expose?: unknown } | null;
  return candidate?.status === 400 && candidate.expose === true;
}

function toEnvelope(exception: unknown): ErrorEnvelope {
  const bodyParser = bodyParserEnvelope(exception);
  if (bodyParser !== undefined) {
    return bodyParser;
  }
  if (exception instanceof CatalogHttpException) {
    return exception.envelope;
  }
  if (exception instanceof HttpException) {
    const code = CODE_BY_FRAMEWORK_STATUS[exception.getStatus()];
    if (code === undefined) {
      return envelopeFor('INTERNAL_ERROR');
    }
    return envelopeFor(code, validationDetails(exception));
  }
  return envelopeFor('INTERNAL_ERROR');
}

// Nest's ValidationPipe passes an array of rule messages as the body `message`; those become `details`.
// Any other body shape contributes no details and the fixed catalog message is used.
function validationDetails(exception: HttpException): string[] {
  const body = exception.getResponse();
  const raw = (body as { message?: unknown } | null)?.message;
  return Array.isArray(raw) ? raw.map(String) : [];
}

function sourceKind(exception: unknown): string | undefined {
  return exception instanceof CatalogHttpException ? exception.kind : undefined;
}

function errorName(exception: unknown): string {
  return exception instanceof Error ? exception.name : 'NonErrorThrown';
}

// 5xx messages are logged for diagnosis, but masked: an unexpected exception can quote an email,
// a document or a phone number taken from the request.
function errorMessage(exception: unknown): string {
  return exception instanceof Error ? maskFreeText(exception.message) : 'Non-Error value thrown';
}
