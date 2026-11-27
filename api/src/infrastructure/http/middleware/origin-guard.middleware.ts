import type { ServerResponse } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import {
  describeOriginSecretError,
  ORIGIN_SECRET_PROVIDER,
  type OriginSecretSource,
} from '../../config/origin-secret.provider';
import { envelopeFor } from '../error-catalog';
import { JsonLogger } from '../logging/json-logger';
import { timingSafeEqualStrings } from '../security/timing-safe-equal';
import type { RequestWithId } from './request-id.middleware';

export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

export type OriginRejectionReason = 'missing_header' | 'invalid_header' | 'secret_unavailable';

// Minimal logger contract; the JSON logger satisfies it structurally.
export interface OriginGuardLogger {
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

const FORBIDDEN_BODY = JSON.stringify(envelopeFor('FORBIDDEN_ORIGIN'));

// Structurally matches Nest's NestMiddleware contract (`use(req, res, next)`).
@Injectable()
export class OriginGuardMiddleware {
  constructor(
    @Inject(ORIGIN_SECRET_PROVIDER) private readonly originSecret: OriginSecretSource,
    @Inject(JsonLogger) private readonly logger: OriginGuardLogger,
  ) {}

  use(req: RequestWithId, res: ServerResponse, next: () => void): void {
    const received = req.headers[ORIGIN_VERIFY_HEADER];
    if (received === undefined || received === '') {
      this.reject(req, res, 'missing_header');
      return;
    }
    // Node joins repeated custom headers with ", " except for a few; an array is never a valid secret.
    if (typeof received !== 'string') {
      this.reject(req, res, 'invalid_header');
      return;
    }

    const expected = this.originSecret.get();
    if (expected.isErr()) {
      // Fail closed. The error names only the parameter, never a value.
      this.logger.error('Origin secret unavailable', {
        requestId: req.requestId,
        reason: 'secret_unavailable' satisfies OriginRejectionReason,
        detail: describeOriginSecretError(expected.error),
      });
      this.respond(res);
      return;
    }

    if (!timingSafeEqualStrings(expected.value, received)) {
      this.reject(req, res, 'invalid_header');
      return;
    }
    next();
  }

  private reject(req: RequestWithId, res: ServerResponse, reason: OriginRejectionReason): void {
    this.logger.warn('Origin rejected', { requestId: req.requestId, reason });
    this.respond(res);
  }

  private respond(res: ServerResponse): void {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(FORBIDDEN_BODY);
  }
}
