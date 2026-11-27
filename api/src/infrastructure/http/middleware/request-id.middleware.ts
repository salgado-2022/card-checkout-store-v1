import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable } from '@nestjs/common';

export const REQUEST_ID_HEADER = 'x-request-id';

// An incoming id is reused only when it is 8 to 64 characters from this set; anything else is replaced.
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

// Express's Request extends IncomingMessage, so Express handlers can use this type directly.
export interface RequestWithId extends IncomingMessage {
  requestId?: string;
}

// Structurally matches Nest's NestMiddleware contract (`use(req, res, next)`).
@Injectable()
export class RequestIdMiddleware {
  use(req: RequestWithId, res: ServerResponse, next: () => void): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
