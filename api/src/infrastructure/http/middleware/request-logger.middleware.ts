import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { JsonLogger } from '../logging/json-logger';
import type { RequestWithId } from './request-id.middleware';

const UNKNOWN_REQUEST_ID = 'unknown';

// Structurally matches Nest's NestMiddleware contract (`use(req, res, next)`).
// Logs only the fields listed in requirement 17.1: no headers, no query string, no body.
@Injectable()
export class RequestLoggerMiddleware {
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  use(req: RequestWithId, res: ServerResponse, next: () => void): void {
    const startedAt = performance.now();
    res.on('finish', () => {
      this.logger.info('request completed', {
        requestId: req.requestId ?? UNKNOWN_REQUEST_ID,
        method: req.method ?? 'UNKNOWN',
        path: pathWithoutQuery(req.url),
        statusCode: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    next();
  }
}

function pathWithoutQuery(url: string | undefined): string {
  if (url === undefined) {
    return '/';
  }
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}
