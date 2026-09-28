/** In-memory token bucket keyed by principal (or client address). */
export interface RateLimiter {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(options: {
  perMinute: number;
  burst: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const refillPerMs = options.perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; updated: number }>();
  let lastSweep = now();
  return {
    take(key) {
      if (options.perMinute <= 0) return { allowed: true, retryAfterSeconds: 0 };
      const t = now();
      if (t - lastSweep > 5 * 60_000) {
        for (const [k, b] of buckets) if (t - b.updated > 10 * 60_000) buckets.delete(k);
        lastSweep = t;
      }
      const bucket = buckets.get(key) ?? { tokens: options.burst, updated: t };
      bucket.tokens = Math.min(options.burst, bucket.tokens + (t - bucket.updated) * refillPerMs);
      bucket.updated = t;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        buckets.set(key, bucket);
        return { allowed: true, retryAfterSeconds: 0 };
      }
      buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
      };
    },
  };
}
