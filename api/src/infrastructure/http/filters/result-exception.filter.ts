import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { JsonLogger } from '../logging/json-logger';
import type { RequestWithId } from '../middleware/request-id.middleware';

export interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
  details: string[];
}

interface LoggerPort {
  warn(message: string, fields?: Record<string, string | number | undefined>): void;
  error(message: string, fields?: Record<string, string | number | undefined>): void;
}

const INTERNAL_ERROR_STATUS = 500;
const INTERNAL_ERROR_MESSAGE = 'Internal server error.';

// Codes follow the API error table in the design. Statuses outside this table fall back to HTTP_ERROR.
const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
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
    const fields = {
      requestId,
      statusCode: envelope.statusCode,
      code: envelope.code,
      errorName: errorName(exception),
      errorMessage: errorMessage(exception),
    };
    if (envelope.statusCode >= INTERNAL_ERROR_STATUS) {
      this.logger.error('Request failed', fields);
    } else {
      this.logger.warn('Request rejected', fields);
    }
  }
}

function toEnvelope(exception: unknown): ErrorEnvelope {
  if (exception instanceof HttpException) {
    const { message, details } = describeHttpException(exception);
    const statusCode = exception.getStatus();
    return {
      statusCode,
      code: CODE_BY_STATUS[statusCode] ?? 'HTTP_ERROR',
      message,
      details,
    };
  }
  return {
    statusCode: INTERNAL_ERROR_STATUS,
    code: 'INTERNAL_ERROR',
    message: INTERNAL_ERROR_MESSAGE,
    details: [],
  };
}

// Nest's ValidationPipe passes an array of rule messages as `message`; those become `details`.
function describeHttpException(exception: HttpException): { message: string; details: string[] } {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return { message: body, details: [] };
  }
  const raw = (body as { message?: unknown }).message;
  if (Array.isArray(raw)) {
    return { message: exception.message, details: raw.map(String) };
  }
  if (typeof raw === 'string') {
    return { message: raw, details: [] };
  }
  return { message: exception.message, details: [] };
}

function errorName(exception: unknown): string {
  return exception instanceof Error ? exception.name : 'NonErrorThrown';
}

function errorMessage(exception: unknown): string {
  return exception instanceof Error ? exception.message : 'Non-Error value thrown';
}
