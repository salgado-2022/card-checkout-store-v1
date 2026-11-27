import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { clientIpTracker } from './client-ip';
import { RATE_LIMIT_THROTTLERS } from './rate-limit.config';

// Wiring only (excluded from coverage). Counters live in the default in-memory storage.
@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: RATE_LIMIT_THROTTLERS, getTracker: clientIpTracker }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
