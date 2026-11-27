import type { Clock } from '../../application/ports/clock';

// Reads the wall clock. Tests replace it through jest fake timers or a plain fake Clock.
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
