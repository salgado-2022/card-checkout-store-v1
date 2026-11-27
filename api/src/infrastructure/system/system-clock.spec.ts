import { SystemClock } from './system-clock';

describe('SystemClock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a Date for the current instant', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-06T07:08:09.010Z'));

    const now = new SystemClock().now();

    expect(now).toBeInstanceOf(Date);
    expect(now.toISOString()).toBe('2026-05-06T07:08:09.010Z');
  });

  it('moves forward with the wall clock', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const clock = new SystemClock();
    const first = clock.now();

    jest.advanceTimersByTime(1500);

    expect(clock.now().getTime() - first.getTime()).toBe(1500);
  });
});
