import type { Clock } from '../../src/application/ports/clock';

export const DEFAULT_FAKE_START = '2026-01-15T10:00:00.000Z';

/** Settable and advanceable clock. `now()` returns a copy so callers cannot mutate its state. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = DEFAULT_FAKE_START) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(instant: Date | string): void {
    this.current = new Date(instant).getTime();
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}
