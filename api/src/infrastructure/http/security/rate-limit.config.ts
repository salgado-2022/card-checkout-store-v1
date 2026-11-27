import type { ThrottlerOptions } from '@nestjs/throttler';

// Requirement 15.2: at most 60 requests per Client_IP in any 60 s window (sliding log).
// blockDuration 0 disables the throttler's penalty block (it defaults to ttl), so a rejected
// request only gets 429 and never extends the block; the window alone decides when a client recovers.
// Kept out of rate-limit.module.ts, which is excluded from coverage and must stay wiring only.
export const RATE_LIMIT_THROTTLERS: ThrottlerOptions[] = [
  { name: 'default', ttl: 60_000, limit: 60, blockDuration: 0 },
];
