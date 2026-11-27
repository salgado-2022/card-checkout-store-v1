import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
export interface HealthResponse {
  status: 'ok';
}
// No dependencies are injected on purpose: the endpoint cannot perform I/O while handling a request.
// SkipThrottle keeps health checks out of the Client_IP rate limit (Requirement 15.12).
@Controller('health')
export class HealthController {
  @Get()
  @SkipThrottle()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
