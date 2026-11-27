import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
}

// No dependencies are injected on purpose: the endpoint cannot perform I/O while handling a request.
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
