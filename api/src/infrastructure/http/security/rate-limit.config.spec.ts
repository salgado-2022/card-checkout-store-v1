import { RATE_LIMIT_THROTTLERS } from './rate-limit.config';

describe('RATE_LIMIT_THROTTLERS', () => {
  it('defines exactly one throttler named default', () => {
    expect(RATE_LIMIT_THROTTLERS).toHaveLength(1);
    expect(RATE_LIMIT_THROTTLERS[0].name).toBe('default');
  });

  it('allows 60 requests in a 60 second window', () => {
    expect(RATE_LIMIT_THROTTLERS[0].limit).toBe(60);
    expect(RATE_LIMIT_THROTTLERS[0].ttl).toBe(60_000);
  });

  it('disables the penalty block so a rejected request never extends the block', () => {
    expect(RATE_LIMIT_THROTTLERS[0].blockDuration).toBe(0);
  });
});
