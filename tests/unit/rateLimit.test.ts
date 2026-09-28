import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/transport/rateLimit.js';

describe('rate limiter', () => {
  it('allows bursts then refills over time', () => {
    let t = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 2, now: () => t });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    const denied = limiter.take('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limiter.take('b').allowed).toBe(true);
    t += 1000;
    expect(limiter.take('a').allowed).toBe(true);
  });
  it('is disabled when perMinute is 0', () => {
    const limiter = createRateLimiter({ perMinute: 0, burst: 1 });
    for (let i = 0; i < 10; i++) expect(limiter.take('x').allowed).toBe(true);
  });
});
